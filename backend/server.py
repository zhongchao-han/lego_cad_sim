import asyncio
import json
import logging
import os
from typing import Optional, List

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
from backend.port_semantics import get_interface, build_fit_result
from backend.port import Port
from backend.math_utils import purify_rotation_matrix, matrix_to_list
from backend.site_utils import cluster_ports_into_sites, sites_to_response
from backend.plug_clustering import compute_plugs as _compute_plugs
from backend.auto_latch_scanner import AutoLatchScanner, serialize_port_key
from backend.urdf_exporter import floating_base_for_mode
from backend.mesh_asset_manager import MeshAssetManager
from backend.idempotency import IdempotencyCache, IdempotencyMiddleware
from backend.category import categorize_part, extract_tooth_count
from backend import semantic_search
from backend.mass_estimator import estimate_mass_com_for_part
from backend.statics_solver import solve_reactions
from backend.stress_analysis import enrich_reactions_with_stress
from backend import build_store
# 配置日志记录
logging.basicConfig(level=logging.DEBUG, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)
# [SNAP-DBG] 本地调试：把 INFO+ 日志镜像到文件，便于排查 snap/连接链路（每次启动覆盖）。
try:
    _dbg_fh = logging.FileHandler('dev_backend.log', mode='w', encoding='utf-8')
    _dbg_fh.setLevel(logging.INFO)
    _dbg_fh.setFormatter(logging.Formatter('%(asctime)s - %(levelname)s - %(message)s'))
    logging.getLogger().addHandler(_dbg_fh)
except Exception:
    pass

# --- 服务实体与配置 ---

# 路径锚点：以本文件所在目录的父目录（即 backend/.. = 仓库根）为基准，
# 解耦 cwd —— 在 git worktree 或任意子目录启动时仍能正确命中主仓库的缓存目录。
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load_local_env() -> None:
    """轻量 .env 加载（无第三方依赖）：读取 backend/.env，把未在进程环境里的键写进
    os.environ。用于本地放置 DEEPSEEK_API_KEY 等密钥（.env 已被 .gitignore 忽略，
    永不入库）。已存在的环境变量优先（CI / 部署可直接注入，不被 .env 覆盖）。"""
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if not os.path.exists(env_path):
        return
    try:
        with open(env_path, "r", encoding="utf-8") as f:
            for raw in f:
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                key, val = key.strip(), val.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = val
    except OSError as exc:
        logger.warning("[env] failed to read %s: %s", env_path, exc)


_load_local_env()

# LDRAW_PARTS_ROOT 配置
LDRAW_PARTS_ROOT = os.environ.get("LDRAW_PARTS_ROOT", os.path.join(_REPO_ROOT, "ldraw_lib"))
# 零件中文名 / 描述映射（backend/gen_zh_names.py 生成）。懒加载 + 模块级缓存；缺文件返回空 dict 不致命。
ZH_NAMES_FILE = os.path.join(_REPO_ROOT, "data", "part_names_zh.json")
_ZH_NAMES_CACHE: Optional[dict] = None
def _get_zh_names() -> dict:
    global _ZH_NAMES_CACHE
    if _ZH_NAMES_CACHE is None:
        try:
            with open(ZH_NAMES_FILE, encoding="utf-8") as f:
                _ZH_NAMES_CACHE = json.load(f)
        except (OSError, ValueError) as exc:
            logger.warning("[zh_names] 加载 %s 失败，中文名留空: %s", ZH_NAMES_FILE, exc)
            _ZH_NAMES_CACHE = {}
    return _ZH_NAMES_CACHE
MESH_CACHE_ROOT = os.environ.get("MESH_CACHE_ROOT", os.path.join(_REPO_ROOT, "data", "custom_assets"))
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

# 幂等键中间件 —— 所有 mutating POST 端点（snap_parts/apply_force/verify/...）
# 接受 Idempotency-Key header；同 key 同 body 直接回放缓存响应，杜绝
# MultiDiGraph.add_edge 在重放下产生重复幽灵边等问题。详见 backend/idempotency.py。
idem_cache = IdempotencyCache()
app.add_middleware(IdempotencyMiddleware, cache=idem_cache)

app.mount("/ldraw_meshes", StaticFiles(directory=MESH_CACHE_ROOT), name="ldraw_meshes")
# 挂载缩略图静态服务
app.mount("/api/thumbnails", StaticFiles(directory=THUMBNAIL_CACHE_ROOT), name="thumbnails")

# --- API 数据模型定义 ---

class ScenePartPose(BaseModel):
    """场景内单件的位姿快照（snap_parts 扩 scope 用）。"""
    part_id: str
    ldraw_id: str
    world_pos: list  # [x, y, z] 米
    world_rot: list  # 9 个浮点（3x3 row-major）


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
    # v4.0 / L45：原始 LDraw .dat 文件名。urdf_exporter 用它查 tooth_count，
    # 决定是否在 URDF 里给齿轮 joint 生成 <mimic> 跟随。老前端不传保持兼容。
    parent_ldraw_id: Optional[str] = None
    child_ldraw_id: Optional[str] = None
    # v4.1 (PR #182): AutoLatch 扩 scope —— 后端从「parent ↔ child 两件」
    # 扩到「child 连通组 × 全场静止件」。前端在 snap 落定时算好这两组的世界位姿
    # 一并传入，后端不必维护场景全态。老前端不传 → 自动退回老范围（仅 parent ↔ child）。
    #
    # child_group_members: child 的连通组成员（含 child 本身），snap 后的世界位姿
    # scene_static_parts: 场景活动区内 **不属于** child_group 的所有件（含 parent），
    #                     snap 前后位姿不变
    child_group_members: Optional[list] = None  # List[ScenePartPose] — Pydantic 会自动校验
    scene_static_parts: Optional[list] = None

class ForceRequest(BaseModel):
    link_name: str
    force: list
    position: list = [0, 0, 0]

class BuildPutRequest(BaseModel):
    """整份草稿的后台同步写入。data 为前端 persist 序列化串（后端不解析其内部结构）。
    client_ts 为前端落定时间戳（毫秒），用于 last-write-wins 排序。"""
    data: str
    client_ts: float

class LDrawPort(BaseModel):
    name: str
    type: str
    gender: Optional[str] = None
    position: list
    rotation: list
    is_manually_adjusted: bool = False
    plug_id: Optional[str] = None  # 走法 A 期 A2：port 归属的 plug

class LDrawSite(BaseModel):
    """物理坑位：共享同一中心点的一组端口。"""
    id: str
    position: list
    occupied_by: Optional[str] = None
    ports: List[LDrawPort]
    plug_ids: List[str] = []  # 走法 A 期 A2：site 涉及的 plug（同 site 跨 plug 时含多个）

class LDrawPlug(BaseModel):
    """plug-level 抽象（走法 A 期 A2）— 用户视角下的整片接口聚合。"""
    plug_id: str
    label: str
    gender: str
    profile: str
    direction: list
    members: list  # List[(site_id, port_idx)] tuples — JSON 序列化为 [str, int]
    port_count: int
    site_ids: List[str]

class BoundingBox(BaseModel):
    size: list
    center: list

class LDrawPartResponse(BaseModel):
    part_id: str
    ports: List[LDrawPort]         # 向后兼容：保留扁平 Port 列表
    sites: List[LDrawSite] = []   # 按物理位点聚类后的 Site 列表
    plugs: List[LDrawPlug] = []   # 走法 A 期 A2：plug-level 聚合
    mesh_url: Optional[str] = None
    bounding_box: Optional[BoundingBox] = None

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
    """获取物料库所需的已复核零件摘要，附带：
    - L50 分级目录所需的 name + category
    - L44 齿轮咬合所需的 tooth_count（非齿轮 / 异形齿轮为 None）
    - L51 整体 COM 计算所需的 mass_kg + com_local（GLB 没烘 → None）
    - L51b 精修 footprint 所需的 bbox_size + bbox_center（cached_data 没有 → None）
    """
    base = port_lib_manager.get_verified_parts()
    parts_dir = os.path.join(LDRAW_PARTS_ROOT, "parts")
    for entry in base:
        name, category = categorize_part(entry["part_id"], parts_dir)
        entry["name"] = name
        entry["category"] = category
        zh = _get_zh_names().get(entry["part_id"], {})
        entry["zh_name"] = zh.get("zh_name", "")
        entry["zh_desc"] = zh.get("zh_desc", "")
        entry["tooth_count"] = extract_tooth_count(name)
        # L51：lazy 跑 trimesh.volume；GLB 已烘则查表，未烘则 None（前端
        # 走 fallback 0.001 kg）。lru_cache 摊销；首次请求轻微延迟可接受。
        mass_com = estimate_mass_com_for_part(mesh_manager, entry["part_id"], color_code=7)
        if mass_com is not None:
            entry["mass_kg"] = mass_com[0]
            entry["com_local"] = list(mass_com[1])
        else:
            entry["mass_kg"] = None
            entry["com_local"] = None
        # L51b：bbox 直接从 port_lib_manager 的持久化 cached_data 读（GeometryProcessor
        # 在 /api/ldraw_part 路径上会数据自愈写入）。暴露到这里让前端 staticsMath
        # 能按 bbox 8 角点重建 footprint，比 v1 用 part.position 单点准确得多。
        bbox = port_lib_manager._data.get(entry["part_id"], {}).get("bounding_box")
        if bbox and "size" in bbox and "center" in bbox:
            entry["bbox_size"] = list(bbox["size"])
            entry["bbox_center"] = list(bbox["center"])
        else:
            entry["bbox_size"] = None
            entry["bbox_center"] = None
    return base


@app.post("/api/compute_reactions")
async def compute_reactions():
    """L51b PR-B：跑一次反力求解，返回每条 ConnectionEdge 的 6D wrench。
    前端 ReactionForceVisualizer 据此着色。

    输入：当前 topo_manager 状态（无 body 参数）。
    输出：dict<edge_key, { force, torque, magnitude_force, ..., parent_id, ... }>。
    复杂度：N parts × M edges → 6N×(6M+6) 矩阵 lstsq，典型场景 < 50ms。
    """
    try:
        result = await asyncio.to_thread(
            solve_reactions, topo_manager, mesh_manager,
        )
        # L51b PR-C：把 reaction force 投到 port 圆截面算 von Mises σ_vm + safety
        # ratio。仅 CYLINDER profile 的 edge 给 stress dict，其他给 None。
        await asyncio.to_thread(enrich_reactions_with_stress, result, topo_manager)
        return {"status": "success", "reactions": result}
    except Exception as exc:  # noqa: BLE001
        logger.error("[compute_reactions] 求解失败: %s", exc, exc_info=True)
        return {"status": "error", "msg": str(exc), "reactions": {}}


# --- 开发与维护离线工具包 (非侵入式热挂载) ---
try:
    from backend.dev_tools_api import router as dev_tools_router
    app.include_router(dev_tools_router, tags=["dev_tools"])
except ImportError as e:
    logger.warning(f"开发工具包挂载失败或未启用: {e}")


@app.get("/api/verify/search")
async def search_parts_legacy(q: str):
    """在全文库中搜索零件（包括已复核和未复核）- 遗留的内存级查找。"""
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

# ── 本地向量语义搜索 ────────────────────────────────────────────────────────
# 取代原 Meilisearch 服务 + DeepSeek 在线改写：零件检索文本离线编码成向量
# （backend/build_search_index.py），运行期对查询同模型编码 + 余弦相似度排序。
# 中文口语描述（"起重机旋转的那种大齿轮"）靠语义相似度直接命中，不再依赖外部服务。

class SearchRequest(BaseModel):
    query: str
    limit: int = 50
    verified_only: bool = True


@app.post("/api/search")
async def search_parts(req: SearchRequest):
    """本地向量语义搜索。返回命中零件列表（按相关度降序）。"""
    q = (req.query or "").strip()
    if not q:
        return {"status": "success", "hits": []}
    try:
        hits = await asyncio.to_thread(
            semantic_search.search, q, req.limit, req.verified_only
        )
    except FileNotFoundError as e:
        logger.error(f"[search] 向量索引缺失: {e}")
        return {"status": "error", "msg": str(e), "hits": []}
    except Exception as e:
        logger.error(f"[search] 搜索失败: {e}", exc_info=True)
        return {"status": "error", "msg": f"搜索失败: {e}", "hits": []}
    return {"status": "success", "hits": hits}


@app.on_event("startup")
async def _warmup_search_index() -> None:
    """后台预热向量模型 + 索引，避免首次搜索阻塞用户。"""
    asyncio.get_event_loop().run_in_executor(None, semantic_search.warmup)

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
        if isinstance(v, list): return [clean_pos(i) for i in v]
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

            # 热更新向量索引里该零件的状态（文本/向量与状态无关，无需重新编码）。
            # 让刚复核通过的零件立即出现在「仅已复核」的搜索结果里。
            try:
                semantic_search.set_status(req.part_id, "verified")
            except Exception as idx_err:
                logger.warning(f"复核保存成功，但热更新搜索索引状态失败: {idx_err}")

            logger.debug(f"[DEBUG] save_verification() 返回成功响应: {req.part_id}")
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
            # L45：传入 LDraw parts 目录，让 urdf_exporter 给齿轮对生成 <mimic>。
            # issue #51：按 mode 决定浮空根。进 SIMULATION → floating_base=True
            # （6DOF 浮空，符合 Gazebo/ROS2 物理预期），ASSEMBLY 钉死不导出。
            topo_manager.export_urdf(
                tree, urdf_path,
                ldraw_parts_dir=os.path.join(LDRAW_PARTS_ROOT, "parts"),
                floating_base=floating_base_for_mode(mode),
            )

            # L55：所有 engine 调用走 to_thread 避免阻塞 asyncio。reset() 在锁内
            # 销毁旧 client 并重建，保留 self._lock，比旧版直接 engine.__init__()
            # 安全 —— 旧写法会替换锁，让任何 in-flight to_thread 拿的是孤儿锁。
            await asyncio.to_thread(engine.reset, "DIRECT")
            success = await asyncio.to_thread(engine.load_assembly, urdf_path)
            if success:
                for loop in topo_manager.closed_loops:
                    await asyncio.to_thread(
                        engine.add_closed_loop_constraint, loop.parent_id, loop.child_id
                    )
                await asyncio.to_thread(engine.toggle_gravity, True)
                system_mode = "SIMULATION"
                return {"status": "success", "msg": "Simulation started."}
            else:
                return {"status": "error", "msg": "URDF load failed."}

    elif mode == "ASSEMBLY":
        if system_mode != "ASSEMBLY":
            await asyncio.to_thread(engine.toggle_gravity, False)
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
        
        # --- v3.2 Bounding Box 数据自愈处理 ---
        bounding_box = None
        if cached_data and "bounding_box" in cached_data:
            bounding_box = cached_data["bounding_box"]
        else:
            # 实时计算包围盒并实施数据自愈更新
            logger.info(f"[*] 包围盒数据缺失，实时计算并注入: {dat_filename}")
            abs_glb_path = mesh_manager.get_absolute_glb_path(dat_filename, color, cached_data.get("glb_path") if cached_data else None)
            bounding_box = geo_proc.compute_bounding_box(abs_glb_path)
            if bounding_box and cached_data:
                cached_data["bounding_box"] = bounding_box
                # force=True 确保无视 verified 人工核验锁
                port_lib_manager.update_part(dat_filename, cached_data, force=True)
                port_lib_manager.save()
        
        # [短路逻辑]: 如果零件已人工复核，直接返回缓存中的 Sites
        if cached_data and cached_data.get("status") == "verified":
            logger.info(f"[CACHE] {dat_filename} 已复核，跳过重新聚类直接返回。")
            
            flattened_ports = []
            if "sites" in cached_data:
                for s_cfg in cached_data["sites"]:
                    s_pos = s_cfg.get("position", [0, 0, 0])
                    for p_cfg in s_cfg.get("ports", []):
                        if "position" not in p_cfg:
                            p_cfg["position"] = s_pos
                        flattened_ports.append(LDrawPort(**p_cfg))
            elif "ports" in cached_data:
                flattened_ports = [LDrawPort(**p) for p in cached_data["ports"]]

            # 走法 A 期 A2：plug 字段。优先 baked，老数据 fallback runtime 现算。
            if cached_data.get("plug_version") and "plugs" in cached_data:
                plugs_serialized = [LDrawPlug(**p) for p in cached_data["plugs"]]
            else:
                plugs_serialized = [
                    LDrawPlug(**p.to_dict())
                    for p in _compute_plugs(cached_data.get("sites", []), dat_filename)
                ]

            return LDrawPartResponse(
                part_id=dat_filename,
                ports=flattened_ports,
                sites=[LDrawSite(**s) for s in cached_data.get("sites", [])],
                plugs=plugs_serialized,
                mesh_url=cached_data.get("mesh_url") or mesh_url,
                bounding_box=BoundingBox(**bounding_box) if bounding_box else None
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
            
            # 若连缓存都没有，顺便将计算好的 bounding box 供前端使用
            if not bounding_box:
                bounding_box = geo_proc.compute_bounding_box(dat_filename)

        # 动态聚类：无论从缓存还是实时解析，均在查询时计算 Sites
        ports_raw = [p.model_dump() for p in ports]
        computed_sites = cluster_ports_into_sites(ports_raw, dat_filename)
        sites_response = sites_to_response(computed_sites)
        sites_serialized = [LDrawSite(**s) for s in sites_response]

        # plug-level 抽象（走法 A 期 A2）：动态聚类路径下 baked 数据缺失，runtime 现算
        plugs_serialized = [
            LDrawPlug(**p.to_dict())
            for p in _compute_plugs(sites_response, dat_filename)
        ]

        return LDrawPartResponse(
            part_id=dat_filename,
            ports=ports,
            sites=sites_serialized,
            plugs=plugs_serialized,
            mesh_url=mesh_url,
            bounding_box=BoundingBox(**bounding_box) if bounding_box else None
        )
    except Exception as e:
        logger.error(f"Failed to get_ldraw_part: {part_id} - {str(e)}", exc_info=True)
        from fastapi import HTTPException
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/snap_parts")
async def snap_parts(req: SnapRequest):
    """只做拓扑记录。插入位姿完全由前端基于零件几何计算。"""
    logger.info(
        f"[SNAP-DBG] /api/snap_parts parent(target)={req.parent_id} ({req.parent_ldraw_id}) "
        f"child(source)={req.child_id} ({req.child_ldraw_id}) | "
        f"port_p={req.port_type_p} port_c={req.port_type_c} | "
        f"parent_world={req.parent_world_pos} child_world={req.child_world_pos}"
    )

    # L45：把前端传的 ldraw_id 落到 PartNode，让 urdf_exporter 能查 tooth_count。
    # 同一 part 已注册时不再覆盖（避免后到的 None 把已存的 ldraw_id 抹掉）。
    pid_to_ldraw = {req.parent_id: req.parent_ldraw_id, req.child_id: req.child_ldraw_id}
    pid_to_world = {req.parent_id: req.parent_world_pos, req.child_id: req.child_world_pos}
    pid_to_rot = {req.parent_id: req.parent_rot, req.child_id: req.child_rot}
    for pid in (req.parent_id, req.child_id):
        if not topo_manager.graph.has_node(pid):
            topo_manager.add_part(PartNode(part_id=pid, name=pid, ldraw_id=pid_to_ldraw[pid]))
        # L45：每次 snap 更新 global_transform —— urdf_exporter 的齿轮 mesh 检测
        # 需要世界位姿来判断"轴线平行 + 中心距匹配"。无 world_pos / rot 不动。
        wp = pid_to_world[pid]
        wr = pid_to_rot[pid]
        if wp is not None and wr is not None and len(wp) >= 3 and len(wr) >= 9:
            node_data = topo_manager.graph.nodes[pid].get('data')
            if node_data is not None:
                T = np.eye(4)
                T[:3, :3] = np.array(wr).reshape(3, 3)
                T[:3,  3] = np.array(wp[:3])
                node_data.global_transform = T

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
    auto_latched_edges_payload: list[dict] = []
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
                # ── v4.1 扩 scope：child 连通组 × 全场静止件扫描 ─────────────
                # 老路径只覆盖 parent ↔ child；如果 child 是销、销又夹在转盘里，
                # 整组跟随 child snap 平移后组里其他销也已经落进其他静止件的孔
                # 1mm 内 —— 老路径漏掉这批边。前端 [FrontendLatch] 是 fallback；
                # 后端原生覆盖才是根治。
                if req.child_group_members or req.scene_static_parts:
                    def _build_pose(item: dict) -> dict:
                        return {
                            "part_id": item.get("part_id"),
                            "ldraw_id": item.get("ldraw_id"),
                            "world_transform": _make_world_t(
                                item.get("world_pos") or [0, 0, 0],
                                item.get("world_rot") or [1, 0, 0, 0, 1, 0, 0, 0, 1],
                            ),
                        }

                    def _load_sites(pid: str, ldraw: str):
                        # 优先按实例 id 查（注册过的件），fallback 用 ldraw_id 查通用配置
                        cfg = port_lib_manager.get_part_data(pid) or port_lib_manager.get_part_data(ldraw)
                        return cfg.get("sites", []) if cfg else []

                    group_poses = [_build_pose(p) for p in (req.child_group_members or [])]
                    static_poses = [_build_pose(p) for p in (req.scene_static_parts or [])]
                    # 主 snap 边 (parent, child) 已通过上面 scan() 处理，群组扫描里跳过
                    extra_edges = scanner.scan_group_against_scene(
                        group_members=group_poses,
                        static_parts=static_poses,
                        sites_loader=_load_sites,
                        exclude_main_pair=(
                            req.parent_id, req.child_id,
                            f"p_{req.parent_id}", f"c_{req.child_id}",
                        ),
                    )
                    # 也跟主 scan() 已收的 new_edges 去重（同一对 port 不重复登记）
                    seen_keys = set()
                    for e in new_edges:
                        a = (e.parent_id, getattr(e.port_parent, "name", "") or "")
                        b = (e.child_id, getattr(e.port_child, "name", "") or "")
                        seen_keys.add(tuple(sorted([a, b])))
                    for e in extra_edges:
                        a = (e.parent_id, getattr(e.port_parent, "name", "") or "")
                        b = (e.child_id, getattr(e.port_child, "name", "") or "")
                        k = tuple(sorted([a, b]))
                        if k in seen_keys:
                            continue
                        seen_keys.add(k)
                        new_edges.append(e)

                auto_latched_count = topo_manager.batch_connect(new_edges)
                logger.info(
                    f"[AutoLatch] Snap({req.parent_id} ↔ {req.child_id}): "
                    f"自动闭合 {auto_latched_count} 条额外连接。"
                )
                try:
                    _dbg_edges = [(getattr(e, 'parent_id', '?'), getattr(e, 'child_id', '?')) for e in new_edges]
                except Exception:
                    _dbg_edges = [('<unserializable>', '')]
                logger.info(
                    f"[SNAP-DBG] AutoLatch scan: parent_sites={len(parent_sites)} child_sites={len(child_sites)} "
                    f"group={len(req.child_group_members or [])} static={len(req.scene_static_parts or [])} "
                    f"-> {auto_latched_count} edges {_dbg_edges}"
                )
                # 把扫描出的边连同序列化的 portKey 一并回流给前端，使其能在
                # connections / occupiedPorts 中同步登记（修补"AutoLatch 边集
                # 在前端缺失"导致旋转锚点查询退化的回流缺口）。仅序列化已
                # 实际登记到拓扑图的边，避免前端写入孤立连接。
                for edge in new_edges:
                    if not topo_manager.graph.has_node(edge.parent_id):
                        continue
                    if not topo_manager.graph.has_node(edge.child_id):
                        continue
                    auto_latched_edges_payload.append({
                        "src_part_id": edge.parent_id,
                        "dst_part_id": edge.child_id,
                        "src_port_key": serialize_port_key(
                            edge.port_parent.position, edge.port_parent.rotation
                        ),
                        "dst_port_key": serialize_port_key(
                            edge.port_child.position, edge.port_child.rotation
                        ),
                    })
            else:
                logger.info(
                    f"[SNAP-DBG] AutoLatch skipped: parent_sites={len(parent_sites)} child_sites={len(child_sites)} (need both non-empty)"
                )
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
        "auto_latched_edges": auto_latched_edges_payload,
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
        # L55：与物理 step 共用 PhysicsEngine._lock，必须经 to_thread 拿锁，
        # 否则同步 lock.acquire 会冻结 asyncio 直到当前 step 完。
        await asyncio.to_thread(engine.apply_user_force, req.link_name, req.force, req.position)
        return {"status": "success"}
    return {"status": "ignored", "msg": "System must be in SIMULATION mode to apply physics forces."}

# --- 草稿持久化（Layer 2：跨设备防丢兜底）---

@app.put("/api/builds/{build_id}")
async def put_build(build_id: str, req: BuildPutRequest):
    """后台同步：前端把整份草稿 PUT 到后端。本地优先，这里只做异地兜底。
    SQLite 调用为同步阻塞，挪到线程池避免卡住 asyncio 主循环。"""
    return await asyncio.to_thread(
        build_store.put_build, build_id, req.data, req.client_ts
    )

@app.get("/api/builds/{build_id}")
async def get_build(build_id: str):
    """拉回某份草稿（设备/浏览器数据丢失后的恢复）。"""
    result = await asyncio.to_thread(build_store.get_build, build_id)
    if result is None:
        return {"status": "not_found"}
    return {"status": "ok", **result}

@app.get("/api/builds")
async def list_builds():
    """列出全部已同步草稿元信息（恢复 UI 用）。"""
    return {"status": "ok", "builds": await asyncio.to_thread(build_store.list_builds)}

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

            # L55：把 stepSimulation × 4 + getState 整段挪到 executor 线程，
            # asyncio 主循环只在 I/O / 短计算上阻塞，HTTP 路由不再被物理积分卡死。
            # PhysicsEngine 内部加了 self._lock 保证 pybullet client 单线程访问。
            if system_mode == "SIMULATION":
                await asyncio.to_thread(engine.step_n, 4)

            state = await asyncio.to_thread(engine.get_state)
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
