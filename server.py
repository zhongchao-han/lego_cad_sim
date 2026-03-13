import asyncio
import json
import logging
import os
from typing import Dict, Any, Optional, List

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from physics_engine import PhysicsEngine
from topology_manager import TopologyManager, PartNode, ConnectionEdge
from ldraw_parser import LDrawParser
from geometry_processor import GeometryProcessor
from fastapi.staticfiles import StaticFiles

logging.basicConfig(level=logging.INFO, format='%(levelname)s: %(message)s')
logger = logging.getLogger(__name__)

# --- 服务实体与配置 ---

app = FastAPI(title="LEGO Technic Simulation Backend", version="1.0.0")

allow_origins_str = os.environ.get("FASTAPI_ALLOW_ORIGINS", "*")
allow_origins = [origin.strip() for origin in allow_origins_str.split(",")] if allow_origins_str else ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

engine = PhysicsEngine(mode="DIRECT")
topo_manager = TopologyManager()

system_mode = "ASSEMBLY"
engine.toggle_gravity(False)

LDRAW_PARTS_ROOT = os.environ.get("LDRAW_PARTS_ROOT", os.path.join(os.getcwd(), "ldraw_lib"))
MESH_CACHE_ROOT = os.path.join(os.getcwd(), "ldraw_meshes")

os.makedirs(MESH_CACHE_ROOT, exist_ok=True)
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
    type: str
    position: list
    rotation: list

class LDrawPartResponse(BaseModel):
    part_id: str
    ports: List[LDrawPort]
    mesh_url: Optional[str] = None

# --- 核心业务 API ---

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


@app.get("/api/ldraw_part/{part_id}", response_model=LDrawPartResponse)
async def get_ldraw_part(part_id: str):
    dat_filename = part_id if part_id.lower().endswith(".dat") else f"{part_id}.dat"

    parser = LDrawParser(ldraw_path=LDRAW_PARTS_ROOT)
    geo_proc = GeometryProcessor(ldraw_path=LDRAW_PARTS_ROOT)

    ports = []
    parsed_ports = parser.parse_dat_file(dat_filename)
    if parsed_ports:
        ports = [LDrawPort(**p.to_dict()) for p in parsed_ports]
    else:
        logger.warning(f"LDraw 源文件未找到或未解析出端口: {dat_filename}")

    glb_filename = f"{part_id}.glb"
    glb_path = os.path.join(MESH_CACHE_ROOT, glb_filename)
    
    if not os.path.exists(glb_path):
        logger.info(f"触发动态转换 (异步线程): {dat_filename} -> {glb_filename}")
        await asyncio.to_thread(geo_proc.convert_to_glb, dat_filename, glb_path)

    mesh_url = f"/ldraw_meshes/{glb_filename}"

    return LDrawPartResponse(
        part_id=part_id,
        ports=ports,
        mesh_url=mesh_url,
    )

@app.post("/api/snap_parts")
async def snap_parts(req: SnapRequest):
    """只做拓扑记录。插入位姿完全由前端基于零件几何计算。"""
    import numpy as np

    for pid in (req.parent_id, req.child_id):
        if not topo_manager.graph.has_node(pid):
            topo_manager.add_part(PartNode(part_id=pid, name=pid))

    p_rot = np.array(req.parent_rot).reshape(3, 3)
    c_rot = np.array(req.child_rot).reshape(3, 3)

    edge = ConnectionEdge(
        parent_id=req.parent_id,
        child_id=req.child_id,
        port_type_p=req.port_type_p,
        port_type_c=req.port_type_c,
        parent_origin=np.array(req.parent_origin),
        parent_rot=p_rot,
        child_origin=np.array(req.child_origin),
        child_rot=c_rot
    )
    topo_manager.connect_ports(edge)
    return {"status": "success", "msg": f"Connected {req.parent_id} to {req.child_id}"}


@app.get("/api/insertion_check")
async def insertion_check(peg_id: str, hole_id: str):
    """
    基于实际网格几何的物理插入检测。
    沿插销轴切片测截面半径，对比梁孔实测内径，返回能否插到底。
    """
    import numpy as np
    
    geo_proc = GeometryProcessor(ldraw_path=LDRAW_PARTS_ROOT)
    parser = LDrawParser(ldraw_path=LDRAW_PARTS_ROOT)
    LDU = 0.0004
    
    peg_dat = peg_id if peg_id.lower().endswith(".dat") else f"{peg_id}.dat"
    hole_dat = hole_id if hole_id.lower().endswith(".dat") else f"{hole_id}.dat"
    
    # ---- 1) 插销：确定主轴，获取截面轮廓 ----
    peg_profile = geo_proc.get_cross_section_profile(peg_dat, axis=0, num_slices=40)
    if not peg_profile:
        return {"error": f"无法提取 {peg_id} 几何"}
    
    bbox_min = peg_profile["bbox_min"]
    bbox_max = peg_profile["bbox_max"]
    extents = [bbox_max[i] - bbox_min[i] for i in range(3)]
    peg_axis = int(np.argmax(extents))
    
    if peg_axis != 0:
        peg_profile = geo_proc.get_cross_section_profile(peg_dat, axis=peg_axis, num_slices=40)
    
    # ---- 2) 梁孔：从端口对推断孔轴和孔径 ----
    hole_ports = parser.parse_dat_file(hole_dat)
    peghole_ports = [p for p in hole_ports if 'hole' in p.port_type]
    
    hole_axis = 1  # 默认 Y
    beam_thickness = 20 * LDU  # 默认 20 LDU
    
    if len(peghole_ports) >= 2:
        # 同一孔的两个端口（位置最近的一对）沿孔轴方向分布
        p0 = peghole_ports[0].position
        p1 = peghole_ports[1].position
        diff = np.abs(p0 - p1)
        hole_axis = int(np.argmax(diff))
        beam_thickness = float(diff[hole_axis])
    
    # 从 peghole.dat 原件几何直接提取精确孔内径
    # peghole.dat 的顶点在 XZ 平面上有两个半径：内壁(6 LDU)和外壁(8 LDU)
    hole_radius = None
    peghole_verts = geo_proc.extract_geometry("peghole.dat")
    if peghole_verts[0]:
        pv = np.array(peghole_verts[0])
        # peghole.dat 的孔轴沿 Y，XZ 平面的半径即为孔径
        xz_dists = np.sqrt(pv[:, 0]**2 + pv[:, 2]**2)
        unique_radii = sorted(set(np.round(xz_dists, 1)))
        if unique_radii:
            # 最小半径 = 孔内壁
            hole_radius = float(unique_radii[0]) * LDU
    
    if not hole_radius:
        hole_radius = 6 * LDU
    
    # ---- 3) 物理可行性分析（含过盈配合模型）----
    #
    # 真实乐高 Technic 配合类型：
    #   - 间隙配合 (clearance):  pin_r ≤ hole_r            → 可自由滑入
    #   - 摩擦配合 (friction):   hole_r < pin_r ≤ 1.15×hole_r  → 塑料微变形，紧密贴合
    #   - 过盈配合 (interference): 1.15×hole_r < pin_r ≤ 1.40×hole_r → 压入，仍可插入
    #   - 不可插入 (blocked):     pin_r > 1.40×hole_r       → 几何上不可能
    #
    # 注: LDraw 模型中摩擦脊尺寸比实物夸大（视觉示意），实际 ABS 塑料
    # 可承受约 0.1-0.3mm 径向变形。LDraw 6558 摩擦脊半径 8 LDU vs 孔 6 LDU
    # (33% 过盈) 在真实乐高中是标准的摩擦配合。
    
    FRICTION_THRESHOLD = 1.15
    INTERFERENCE_THRESHOLD = 1.40
    
    peg_radii = peg_profile["radii"]
    peg_positions = peg_profile["axis_positions"]
    peg_length = peg_positions[-1] - peg_positions[0] if peg_positions else 0
    
    # 逐切片判断配合类型
    fit_types = []
    for r in peg_radii:
        ratio = r / hole_radius if hole_radius > 0 else float('inf')
        if ratio <= 1.0:
            fit_types.append("clearance")
        elif ratio <= FRICTION_THRESHOLD:
            fit_types.append("friction")
        elif ratio <= INTERFERENCE_THRESHOLD:
            fit_types.append("interference")
        else:
            fit_types.append("blocked")
    
    # 可插入 = clearance / friction / interference（blocked 不可通过）
    can_pass = [ft != "blocked" for ft in fit_types]
    
    # 找最长连续可通过区间
    max_run = 0
    current_run = 0
    for cp in can_pass:
        if cp:
            current_run += 1
            max_run = max(max_run, current_run)
        else:
            current_run = 0
    
    slice_step = peg_length / max(len(peg_positions) - 1, 1)
    max_passable = max_run * slice_step
    can_fully_insert = max_passable >= beam_thickness
    
    # 整体配合类型取最紧的那段
    overall_fit = "clearance"
    for ft in fit_types:
        if ft == "blocked":
            overall_fit = "blocked"
            break
        if ft == "interference":
            overall_fit = "interference"
        elif ft == "friction" and overall_fit == "clearance":
            overall_fit = "friction"
    
    # 过盈量（正值=插销比孔大多少）
    peg_max_r = max(peg_radii) if peg_radii else 0
    interference = peg_max_r - hole_radius
    interference_pct = (interference / hole_radius * 100) if hole_radius > 0 else 0
    
    result = {
        "peg_id": peg_id,
        "hole_id": hole_id,
        "peg_axis": peg_axis,
        "hole_axis": hole_axis,
        "peg_length": round(peg_length, 6),
        "hole_radius": round(hole_radius, 6),
        "peg_min_radius": round(min(peg_radii) if peg_radii else 0, 6),
        "peg_max_radius": round(peg_max_r, 6),
        "beam_thickness": round(beam_thickness, 6),
        "max_passable_length": round(max_passable, 6),
        "can_fully_insert": can_fully_insert,
        "fit_type": overall_fit,
        "interference_mm": round(interference * 1000, 3),
        "interference_pct": round(interference_pct, 1),
        "optimal_center_offset": 0.0,
    }
    
    fit_desc = {
        "clearance": "间隙配合(可自由滑入)",
        "friction": "摩擦配合(紧密贴合)",
        "interference": "过盈配合(需压入)",
        "blocked": "不可插入(几何干涉)",
    }
    
    logger.info(
        f"插入检测: {peg_id} → {hole_id}\n"
        f"  配合类型: {fit_desc[overall_fit]}\n"
        f"  插销半径: [{result['peg_min_radius']*1000:.2f}, {result['peg_max_radius']*1000:.2f}] mm\n"
        f"  孔    径: {hole_radius*1000:.2f} mm\n"
        f"  过 盈 量: {interference*1000:.3f} mm ({interference_pct:.1f}%)\n"
        f"  可完全插入: {can_fully_insert}"
    )
    
    return result


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
