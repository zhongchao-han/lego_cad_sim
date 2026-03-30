import asyncio
import json
import logging
import os
from typing import List, Optional

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from backend.auto_latch_scanner import AutoLatchScanner
from backend.geometry_processor import GeometryProcessor
from backend.math_utils import matrix_to_list, purify_rotation_matrix
from backend.mesh_asset_manager import MeshAssetManager
from backend.physics_engine import PhysicsEngine
from backend.port import Port
from backend.port_library import PortLibrary
from backend.port_library_manager import PortLibraryManager
from backend.port_semantics import build_fit_result, get_interface
from backend.site_utils import cluster_ports_into_sites, sites_to_response
from backend.topology_manager import ConnectionEdge, PartNode, TopologyManager

# 配置日志记录
logging.basicConfig(level=logging.DEBUG, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# --- 服务实体与配置 ---

# LDRAW_PARTS_ROOT 配置
LDRAW_PARTS_ROOT = os.environ.get("LDRAW_PARTS_ROOT", os.path.join(os.getcwd(), "ldraw_lib"))
MESH_CACHE_ROOT = os.path.join(os.getcwd(), "data", "custom_assets")
# 新增缩略图缓存目录依赖
THUMBNAIL_CACHE_ROOT = os.path.join(MESH_CACHE_ROOT, "thumbnails")
os.makedirs(MESH_CACHE_ROOT, exist_ok=True)
os.makedirs(THUMBNAIL_CACHE_ROOT, exist_ok=True)

mesh_manager = MeshAssetManager(MESH_CACHE_ROOT)

# --- 初始化后端核心单例组件 ---
# 负责数据持久化（单一真理来源）
port_lib_manager = PortLibraryManager()

# 负责解析语义逻辑 (通过依赖注入共享 Manager 的内存数据，保证一致性)
library = PortLibrary(ldraw_path=LDRAW_PARTS_ROOT, data_store=port_lib_manager._data)

# 负责网格转换与渲染 (静态颜色表缓存)
geo_proc = GeometryProcessor(ldraw_path=LDRAW_PARTS_ROOT)

engine = PhysicsEngine(mode="DIRECT")
topo_manager = TopologyManager()

system_mode = "ASSEMBLY"
engine.toggle_gravity(False)

app = FastAPI(title="LEGO Technic Simulation Backend", version="1.0.0")

# 开发环境下明确指定 Origin 以支持 credentials=True
allow_origins = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:5174",
    "http://127.0.0.1:5174",
    "http://localhost:8000",
    "http://127.0.0.1:8000"
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/ldraw_meshes", StaticFiles(directory=MESH_CACHE_ROOT), name="ldraw_meshes")
# 挂载缩略图静态服务
app.mount("/api/thumbnails", StaticFiles(directory=THUMBNAIL_CACHE_ROOT), name="thumbnails")

# --- API 数据模型定义 ---

class SnapRequest(BaseModel):
    parent_id: str
    child_id: str
    port_type_p: str
    port_type_c: str
    parent_origin: list
    parent_rot: list
    child_origin: list
    child_rot: list
    # v3.1: 世界坐标，用于 AutoLatchScanner 的 Site 距离筛选
    # 格式: [x, y, z]（SI 米制，Y-Up），由前端在 Snap 确认后传入
    parent_world_pos: Optional[list] = None
    child_world_pos: Optional[list] = None

class ForceRequest(BaseModel):
    link_name: str
    force: list
    position: list = [0, 0, 0]

class LDrawPort(BaseModel):
    name: str
    type: str
    gender: Optional[str] = None
    position: list
    rotation: list
    is_manually_adjusted: bool = False

class LDrawSite(BaseModel):
    """物理坑位：共享同一中心点的一组端口。"""
    id: str
    position: list
    occupied_by: Optional[str] = None
    ports: List[LDrawPort]

class LDrawPartResponse(BaseModel):
    part_id: str
    ports: List[LDrawPort]         # 向后兼容：保留扁平 Port 列表
    sites: List[LDrawSite] = []   # 新增：按物理位点聚类后的 Site 列表
    mesh_url: Optional[str] = None

class VerifySaveRequest(BaseModel):
    part_id: str
    sites: List[LDrawSite]

# --- 核心业务 API ---

@app.post("/api/reload_library")
async def reload_library():
    """ 手动刷新后端端口库配置文件 """
    logger.info("收到后端库重载请求...")
    port_lib_manager.load()
    # 强制同步 PortLibrary 以应用最新数据
    library.data = port_lib_manager._data
    return {"status": "success", "part_count": len(port_lib_manager._data)}

@app.get("/api/verify/pending_list")
async def get_pending_list():
    """获取待复核零件列表，按自信度排序。"""
    return port_lib_manager.get_pending_parts()

@app.get("/api/get_verified_parts")
async def get_verified_parts():
    """获取物料库所需的已复核零件摘要。"""
    return port_lib_manager.get_verified_parts()


# --- 开发与维护离线工具包 (非侵入式热挂载) ---
try:
    from backend.dev_tools_api import router as dev_tools_router
    app.include_router(dev_tools_router, tags=["dev_tools"])
except ImportError as e:
    logger.warning(f"开发工具包挂载失败或未启用: {e}")


@app.get("/api/verify/search")
async def search_parts(q: str):
    """在全文库中搜索零件（包括已复核和未复核）。"""
    results = []
    q = q.lower()
    with port_lib_manager._lock:
        for pid, cfg in port_lib_manager._data.items():
            if q in pid.lower():
                # 计算端口数以向后兼容
                if "sites" in cfg:
                    count = sum(len(s.get("ports", [])) for s in cfg["sites"])
                else:
                    count = len(cfg.get("ports", []))

                results.append({
                    "part_id": pid,
                    "status": cfg.get("status", "pending"),
                    "confidence": cfg.get("confidence", 1.0),
                    "port_count": count
                })
    return results[:50]

@app.post("/api/verify_part")
@app.post("/api/verify/save")
async def save_verification(req: VerifySaveRequest):
    """
    接收并保存人工复核的零件配置。
    支持层次化的 Site-Port 结构。
    """
    logger.info(f"收到复核提交: Part ID={req.part_id}, Sites={len(req.sites)}")

    def clean_pos(v):
        if isinstance(v, (float, np.floating)):
            return round(float(v), 6)
        if isinstance(v, list):
            return [clean_pos(i) for i in v]
        return v

    try:
        final_sites = []
        for site_req in req.sites:
            site_dict = site_req.model_dump()
            site_dict["position"] = [clean_pos(x) for x in site_dict["position"]]

            normalized_ports = []
            for p_req in site_req.ports:
                p_data = p_req.model_dump()
                p_data["position"] = [clean_pos(x) for x in p_data["position"]]

                # 核心数学脱敏：入库前强制执行 Gram-Schmidt 正交化
                raw_rot = np.array(p_data["rotation"])
                pure_rot = purify_rotation_matrix(raw_rot)
                p_data["rotation"] = matrix_to_list(pure_rot)

                # 构造 Port 对象以利用 to_dict() 的规范化输出
                obj = Port.from_config(
                    f"{req.part_id}_v", p_data['type'], np.array(p_data['position']), np.array(p_data['rotation']),
                    is_manually_adjusted=p_data.get('is_manually_adjusted', False)
                )
                if obj:
                    normalized_ports.append(obj.to_dict())
                else:
                    normalized_ports.append(p_data)

            site_dict["ports"] = normalized_ports
            final_sites.append(site_dict)

        success = port_lib_manager.update_part_config(
            part_id=req.part_id,
            sites=final_sites,
            status="verified",
            confidence=1.0,
            force=True
        )

        if success:
            port_lib_manager.save()
            return {"status": "success", "msg": f"Part {req.part_id} verified and saved."}
        else:
            return {"status": "error", "msg": "Failed to update config."}

    except Exception as e:
        logger.error(f"保存失败: {e}", exc_info=True)
        return {"status": "error", "msg": str(e)}

@app.post("/api/toggle_mode")
async def toggle_mode(mode: str):
    global system_mode
    mode = mode.upper()

    if mode == "SIMULATION":
        if system_mode != "SIMULATION":
            logger.info("接受前端指令，开始转化拓扑并生成 URDF ...")
            tree = topo_manager.build_spanning_tree()
            urdf_path = "current_assembly.urdf"
            topo_manager.export_urdf(tree, urdf_path)

            engine.disconnect()
            engine.__init__(mode="DIRECT")

            success = engine.load_assembly(urdf_path)
            if success:
                for loop in topo_manager.closed_loops:
                    engine.add_closed_loop_constraint(loop.parent_id, loop.child_id)
                engine.toggle_gravity(True)
                system_mode = "SIMULATION"
                return {"status": "success", "msg": "Simulation started."}
            else:
                return {"status": "error", "msg": "URDF load failed."}

    elif mode == "ASSEMBLY":
        if system_mode != "ASSEMBLY":
            engine.toggle_gravity(False)
            system_mode = "ASSEMBLY"
            return {"status": "success", "msg": "Returned to assembly editor."}

    return {"status": "ok", "msg": "No changes made."}


@app.get("/api/ldraw_part/{part_id:path}")
async def get_ldraw_part(part_id: str, color: int = 7, include_pending: bool = False):
    """请求转换并获取 LDraw 零件。"""
    logger.debug(f"[DEBUG] 进入 get_ldraw_part: part_id={part_id}, color={color}, include_pending={include_pending}")
    try:
        part_id = part_id.strip()
        dat_filename = part_id if part_id.lower().endswith(".dat") else f"{part_id}.dat"

        # 1. 检查持久化层中是否已有烘培好的数据
        cached_data = port_lib_manager.get_part_data(dat_filename)

        # 委托 MeshAssetManager 处理物理存在确认和 URL 路由组装
        mesh_url = mesh_manager.ensure_mesh_exists(
            part_id=dat_filename,
            color_code=color,
            geo_processor=geo_proc,
            cached_glb_path=cached_data.get("glb_path") if cached_data else None
        )

        # [短路逻辑]: 如果零件已人工复核，直接返回缓存中的 Sites
        if cached_data and cached_data.get("status") == "verified":
            logger.info(f"[CACHE] {dat_filename} 已复核，跳过重新聚类直接返回。")
            return LDrawPartResponse(
                part_id=dat_filename,
                ports=[LDrawPort(**p) for p in cached_data.get("ports", [])] if "ports" in cached_data else [],
                sites=[LDrawSite(**s) for s in cached_data.get("sites", [])],
                mesh_url=cached_data.get("mesh_url") or mesh_url
            )

        if cached_data:
            # 优先处理 Site-Based 结构 (v3.1+)
            if "sites" in cached_data:
                ports = []
                for s_cfg in cached_data["sites"]:
                    s_pos = s_cfg.get("position", [0, 0, 0])
                    for p_cfg in s_cfg.get("ports", []):
                        if "position" not in p_cfg:
                            p_cfg["position"] = s_pos
                        ports.append(LDrawPort(**p_cfg))
            # 向后兼容扁平结构
            else:
                ports = [LDrawPort(**p) for p in cached_data.get("ports", [])]
        else:
            # 2. 如果没有，则执行实时高精度解析
            logger.info(f"[*] 缓存缺失，正在为 {dat_filename} 执行实时 v3.0 解析...")
            raw_ports = geo_proc.discover_ports(dat_filename)
            ports = [LDrawPort(**p) for p in raw_ports]

        # 动态聚类：无论从缓存还是实时解析，均在查询时计算 Sites
        ports_raw = [p.model_dump() for p in ports]
        computed_sites = cluster_ports_into_sites(ports_raw, dat_filename)
        sites_serialized = [LDrawSite(**s) for s in sites_to_response(computed_sites)]

        return LDrawPartResponse(
            part_id=dat_filename,
            ports=ports,
            sites=sites_serialized,
            mesh_url=mesh_url
        )
    except Exception as e:
        logger.error(f"Failed to get_ldraw_part: {part_id} - {str(e)}", exc_info=True)
        from fastapi import HTTPException
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/snap_parts")
async def snap_parts(req: SnapRequest):
    """只做拓扑记录。插入位姿完全由前端基于零件几何计算。"""

    for pid in (req.parent_id, req.child_id):
        if not topo_manager.graph.has_node(pid):
            topo_manager.add_part(PartNode(part_id=pid, name=pid))

    p_rot = np.array(req.parent_rot).reshape(3, 3)
    c_rot = np.array(req.child_rot).reshape(3, 3)

    # 用 Port 工厂方法构建强类型端口；从原始 LDraw 矩阵转换
    port_p = Port.from_raw(
        f"p_{req.parent_id}", req.port_type_p,
        np.array(req.parent_origin), p_rot,
        part_context=req.parent_id
    )
    port_c = Port.from_raw(
        f"c_{req.child_id}", req.port_type_c,
        np.array(req.child_origin), c_rot,
        part_context=req.child_id
    )

    if port_p is None or port_c is None:
        return {"status": "error", "msg": "Invalid port types or missing semantic data. Check backend logs."}

    edge = ConnectionEdge(
        parent_id=req.parent_id,
        child_id=req.child_id,
        port_parent=port_p,
        port_child=port_c,
    )
    topo_manager.connect_ports(edge)

    # ── v3.1: Auto-Latch 自动闭合扫描 ────────────────────────────────────────
    # 前提：前端在 Snap 确认后必须传入 parent_world_pos / child_world_pos。
    # 若未传入（如旧版前端），则跳过自动扫描，保持后向兼容。
    auto_latched_count = 0
    if req.parent_world_pos is not None and req.child_world_pos is not None:
        try:
            # 为两个零件各构建一个平移世界变换矩阵（仅位移，旋转部分留待后续版本完善）
            def _make_world_t(origin: list, rot: list) -> np.ndarray:
                T = np.eye(4)
                T[:3, :3] = np.array(rot).reshape(3, 3)
                T[:3,  3] = np.array(origin[:3])
                return T

            parent_T = _make_world_t(req.parent_world_pos, req.parent_rot)
            child_T  = _make_world_t(req.child_world_pos,  req.child_rot)

            # 从真理库加载两个零件的 Site 配置
            parent_cfg = port_lib_manager.get_part_data(req.parent_id)
            child_cfg  = port_lib_manager.get_part_data(req.child_id)
            parent_sites = parent_cfg.get("sites", []) if parent_cfg else []
            child_sites  = child_cfg.get("sites",  []) if child_cfg  else []

            if parent_sites and child_sites:
                scanner = AutoLatchScanner()
                new_edges = scanner.scan(
                    parent_id=req.parent_id,
                    child_id=req.child_id,
                    parent_sites=parent_sites,
                    child_sites=child_sites,
                    parent_world_transform=parent_T,
                    child_world_transform=child_T,
                    exclude_port_pair=(
                        f"p_{req.parent_id}",
                        f"c_{req.child_id}",
                    ),
                )
                auto_latched_count = topo_manager.batch_connect(new_edges)
                logger.info(
                    f"[AutoLatch] Snap({req.parent_id} ↔ {req.child_id}): "
                    f"自动闭合 {auto_latched_count} 条额外连接。"
                )
            else:
                logger.debug(
                    f"[DEBUG] AutoLatch 跳过: parent_sites={len(parent_sites)}, "
                    f"child_sites={len(child_sites)}，其中一方为空。"
                )
        except Exception as exc:
            # 自动扫描失败不应阻断主连接的成功响应（降级处理）
            logger.error(f"[AutoLatch] 扫描异常（主连接已建立）: {exc}", exc_info=True)

    return {
        "status": "success",
        "msg": f"Connected {req.parent_id} to {req.child_id}",
        "auto_latched_count": auto_latched_count,
    }


@app.get("/api/insertion_check")
async def insertion_check(peg_id: str, hole_id: str,
                          peg_type: Optional[str] = None,
                          hole_type: Optional[str] = None):
    """
    物理插入检测。
    """

    fit_desc = {
        "clearance":    "间隙配合(可自由滑入)",
        "friction":     "摩擦配合(紧密贴合)",
        "interference": "过盈配合(需压入)",
        "blocked":      "不可插入(几何干涉)",
        "incompatible": "接口不兼容",
    }

    # ---- 1) 参数化优先路径 ----------------------------------------
    # 解析接口：优先使用显式传入的 peg_type / hole_type，
    # 其次尝试用 peg_id / hole_id 直接查注册表（适用于直接传原件名的场景）
    plug_iface   = get_interface(peg_type)  if peg_type  else get_interface(peg_id)
    socket_iface = get_interface(hole_type) if hole_type else get_interface(hole_id)

    if plug_iface is not None and socket_iface is not None:
        result = build_fit_result(plug_iface, socket_iface, peg_id, hole_id)
        logger.info(
            f"[参数化] 插入检测: {peg_id}({peg_type or peg_id}) → "
            f"{hole_id}({hole_type or hole_id})\n"
            f"  配合类型: {fit_desc.get(result['fit_type'], result['fit_type'])}\n"
            f"  过盈量:   {result['interference_mm']} mm ({result['interference_pct']}%)\n"
            f"  可完全插入: {result['can_fully_insert']}"
        )
        return result

    # ---- 2) 严格模式：拒绝降级到几何切片 -----------------------------
    logger.critical(
        f"\n{'!'*60}\n"
        f"STRICT INSERTION CHECK FAILED: 物理接口定义缺失!\n"
        f"尝试检测: {peg_id} ({peg_type})  VS  {hole_id} ({hole_type})\n"
        f"状态: 系统拒绝使用不可调教的几何切片进行模糊猜测。\n"
        f"修复建议: 请在 port_semantics.py 的注册表中添加这些原件的参数化(Radius/Depth/Fit)。\n"
        f"{'!'*60}\n"
    )
    return {
        "status": "error",
        "msg": f"Missing parameterized definition for {peg_id} or {hole_id}. Strict mode forbids geometry fallback.",
        "method": "strict_error"
    }


@app.post("/api/apply_force")
async def apply_force(req: ForceRequest):
    if system_mode == "SIMULATION":
        engine.apply_user_force(req.link_name, req.force, req.position)
        return {"status": "success"}
    return {"status": "ignored", "msg": "System must be in SIMULATION mode to apply physics forces."}

# --- WebSocket ---

class ConnectionManager:
    def __init__(self):
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        logger.info("新的前端可视化 WebSocket 客户端已挂载。")

    def disconnect(self, websocket: WebSocket):
        self.active_connections.remove(websocket)
        logger.info("前端可视化 WebSocket 客户端已断开。")

    async def broadcast(self, message: str):
        for connection in list(self.active_connections):
            try:
                await connection.send_text(message)
            except Exception as e:
                logger.warning(f"Failed to send to a client, removing from pool: {e}")
                self.disconnect(connection)

manager = ConnectionManager()

@app.websocket("/ws/physics_stream")
async def physics_stream(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            await asyncio.sleep(1/60.0)

            if system_mode == "SIMULATION":
                for _ in range(4):
                    engine.step()

            state = engine.get_state()
            if state:
                payload = json.dumps({"mode": system_mode, "state": state})
                await manager.broadcast(payload)

    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception as e:
        logger.error(f"WebSocket 数据流中断或抛出异常: {e}")
        manager.disconnect(websocket)


if __name__ == "__main__":
    import uvicorn
    print("\n[Phase 4: FastAPI & WebSocket Backend 已准备就绪]")
    uvicorn.run(app, host="0.0.0.0", port=8000)
