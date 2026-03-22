import asyncio
import json
import logging
import os
from typing import Dict, Any, Optional, List

import numpy as np

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from backend.physics_engine import PhysicsEngine
from backend.topology_manager import TopologyManager, PartNode, ConnectionEdge
from backend.port_library import PortLibrary
from backend.geometry_processor import GeometryProcessor
from fastapi.staticfiles import StaticFiles
from backend.port_library_manager import PortLibraryManager
from backend.port_semantics import get_interface, check_fit, build_fit_result, FitType, DELTA_FRICTION_MAX
from backend.port import Port
from backend.core_constants import LDU
from backend.math_utils import purify_rotation_matrix, matrix_to_list

logging.basicConfig(level=logging.INFO, format='%(levelname)s: %(message)s')
logger = logging.getLogger(__name__)

# --- 服务实体与配置 ---

# LDRAW_PARTS_ROOT 配置
LDRAW_PARTS_ROOT = os.environ.get("LDRAW_PARTS_ROOT", os.path.join(os.getcwd(), "ldraw_lib"))
MESH_CACHE_ROOT = os.path.join(os.getcwd(), "ldraw_meshes")
os.makedirs(MESH_CACHE_ROOT, exist_ok=True)

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

class ForceRequest(BaseModel):
    link_name: str
    force: list
    position: list = [0, 0, 0]

class LDrawPort(BaseModel):
    name: str
    type: str
    position: list
    rotation: list

class LDrawPartResponse(BaseModel):
    part_id: str
    ports: List[LDrawPort]
    mesh_url: Optional[str] = None

class VerifySaveRequest(BaseModel):
    part_id: str
    ports: List[LDrawPort]

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

@app.get("/api/verify/search")
async def search_parts(q: str):
    """在全文库中搜索零件（包括已复核和未复核）。"""
    results = []
    q = q.lower()
    with port_lib_manager._lock:
        for pid, cfg in port_lib_manager._data.items():
            if q in pid.lower():
                results.append({
                    "part_id": pid,
                    "status": cfg.get("status", "pending"),
                    "confidence": cfg.get("confidence", 1.0),
                    "port_count": len(cfg.get("ports", []))
                })
    return results[:50] # 限制返回数量防止 UI 爆炸

@app.post("/api/verify/save")
async def save_verified_ports(req: VerifySaveRequest):
    """保存人工复核后的端口数据，状态设为 verified。"""
    try:
        def clean_pos(v):
            if isinstance(v, (float, np.floating)):
                # 宏观治理：由于已切换为 SI 米制，原先 [10 LDU] 级别的吸附逻辑会误杀微小位移。
                # 现在直接保留高精度原始值，物理吸附应交由前端 Grid 或解析脚本负责。
                return round(float(v), 6)
            if isinstance(v, list): return [clean_pos(i) for i in v]
            return v

        def clean_rot(v):
            if isinstance(v, (float, np.floating)):
                return round(float(v), 6)
            if isinstance(v, list): return [clean_rot(i) for i in v]
            return v

        ports_dict = []
        for p in req.ports:
            # 1. 基础清理与格式化
            p_data = p.model_dump()
            p_data["position"] = [clean_pos(x) for x in p_data["position"]]
            
            # 2. 核心数学脱敏：入库前强制执行 Gram-Schmidt 正交化
            raw_rot = np.array(p_data["rotation"])
            pure_rot = purify_rotation_matrix(raw_rot)
            p_data["rotation"] = matrix_to_list(pure_rot)
            
            ports_dict.append(p_data)

        # 统一入库标准：在保存 verified 数据前，确保其轴向是归一化且规整的
        final_ports = []
        for p in ports_dict:
            # 此时 np 已在全局作用域定义
            obj = Port.from_config(
                f"{req.part_id}_v", p['type'], np.array(p['position']), np.array(p['rotation'])
            )
            if obj:
                final_ports.append(obj.to_dict())
            else:
                final_ports.append(p)

        # 注意：这里调用 update_part_config，将状态设为 verified
        success = port_lib_manager.update_part_config(
            part_id=req.part_id,
            ports=final_ports,
            status="verified",
            confidence=1.0,
            force=True  # 人工复核总是强制覆盖
        )
        if success:
            port_lib_manager.save()
            return {"status": "success", "msg": f"Part {req.part_id} verified and saved."}
        else:
            return {"status": "error", "msg": f"Failed to update config for {req.part_id}."}
    except Exception as e:
        logger.error(f"保存复核数据失败: {req.part_id} - {e}", exc_info=True)
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


@app.get("/api/ldraw_part/{part_id:path}", response_model=LDrawPartResponse)
async def get_ldraw_part(part_id: str, color: int = 7, include_pending: bool = False):
    """
    获取 LDraw 零件及其端口数据。使用 v3.0 GeometryProcessor 进行实时准通解析。
    """
    try:
        part_id = part_id.strip()
        dat_filename = part_id if part_id.lower().endswith(".dat") else f"{part_id}.dat"

        # 1. 检查持久化层中是否已有烘培好的 V3.0 数据
        cached_data = port_lib_manager.get_part_data(dat_filename)
        if cached_data and cached_data.get("version") == "v3.0.normalized":
            ports = [LDrawPort(**p) for p in cached_data["ports"]]
            glb_filename = os.path.basename(cached_data["glb_path"])
        else:
            # 2. 如果没有（或版本过旧），则执行实时高精度解析
            logger.info(f"[*] 缓存缺失，正在为 {dat_filename} 执行实时 v3.0 解析...")
            raw_ports = geo_proc.discover_ports(dat_filename)
            ports = [LDrawPort(**p) for p in raw_ports]
            
            # 同时生成预览模型 (Color 7)
            glb_filename = f"{part_id.replace('.dat', '')}_c{color}.glb"
            glb_path = os.path.join(MESH_CACHE_ROOT, glb_filename)
            geo_proc.convert_to_glb(dat_filename, glb_path, color=color)

        return LDrawPartResponse(
            part_id=dat_filename,
            ports=ports,
            mesh_url=f"/ldraw_meshes/{glb_filename}"
        )
    except Exception as e:
        logger.error(f"Failed to get_ldraw_part: {part_id} - {str(e)}", exc_info=True)
        # 显式抛出 500 并在日志中记录调用栈
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
    return {"status": "success", "msg": f"Connected {req.parent_id} to {req.child_id}"}


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
