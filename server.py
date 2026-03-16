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
from connection_interface import get_interface, check_fit, build_fit_result, FitType, DELTA_FRICTION_MAX
from port import Port

logging.basicConfig(level=logging.INFO, format='%(levelname)s: %(message)s')
logger = logging.getLogger(__name__)

LDU = 0.0004  # 1 LDraw Unit = 0.4mm

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
async def get_ldraw_part(part_id: str, color: int = 7):
    import numpy as np

    dat_filename = part_id if part_id.lower().endswith(".dat") else f"{part_id}.dat"

    parser = LDrawParser(ldraw_path=LDRAW_PARTS_ROOT)
    geo_proc = GeometryProcessor(ldraw_path=LDRAW_PARTS_ROOT)

    ports = []
    parsed_ports = parser.parse_dat_file(dat_filename)
    if parsed_ports:
        ports = [LDrawPort(**p.to_dict()) for p in parsed_ports]
    else:
        logger.warning(f"LDraw 源文件未找到或未解析出端口: {dat_filename}")

    glb_filename = f"{part_id}_c{color}.glb"
    glb_path = os.path.join(MESH_CACHE_ROOT, glb_filename)

    if not os.path.exists(glb_path):
        logger.info(f"触发动态转换 (异步线程): {dat_filename} -> {glb_filename}")
        await asyncio.to_thread(geo_proc.convert_to_glb, dat_filename, glb_path, color_code=color)

    mesh_url = f"/ldraw_meshes/{glb_filename}"

    peg_ports = [p for p in ports if not p.type.lower().endswith('hole.dat')]
    if peg_ports:
        verts_ldu, _, _ = geo_proc.extract_geometry(dat_filename)
        if verts_ldu:
            verts_si = np.array(verts_ldu) * LDU
            for p in peg_ports:
                rot = np.array(p.rotation)
                pos = np.array(p.position)
                inward_axis = rot @ np.array([0.0, 1.0, 0.0])
                tip_dir = -inward_axis
                tip_dir /= (np.linalg.norm(tip_dir) + 1e-12)
                projections = verts_si @ tip_dir
                max_proj = float(np.max(projections))
                current_proj = float(np.dot(pos, tip_dir))
                p.position = (pos + (max_proj - current_proj) * tip_dir).tolist()
            logger.info(f"[{part_id}] peg 端口已投影到网格边界尖端")

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

    # 用 Port 工厂方法构建强类型端口；未知类型自动降级，不阻断流程
    port_p = Port.from_ldraw_or_fallback(
        f"p_{req.parent_id}", req.port_type_p,
        np.array(req.parent_origin), p_rot,
    )
    port_c = Port.from_ldraw_or_fallback(
        f"c_{req.child_id}", req.port_type_c,
        np.array(req.child_origin), c_rot,
    )

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

    优先路径（参数化查表，O(1)）：
      若 peg_type / hole_type 已知，或 peg_id / hole_id 本身就是已注册的接口名称
      （如 "pin.dat", "peghole.dat", "peg", "peghole"），则直接用参数化公差表判定。
      无需加载任何网格，响应极快。

    降级路径（网格切片，O(n)）：
      仅当零件完全未知时才调用原来的几何处理逻辑，保证对非标准零件的兼容性。
    """
    import numpy as np

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

    # ---- 2) 降级路径：网格切片（仅用于未注册的非标准零件）-----------
    logger.info(f"[网格切片] {peg_id} / {hole_id} 未在接口注册表中，降级到几何处理")

    geo_proc = GeometryProcessor(ldraw_path=LDRAW_PARTS_ROOT)
    parser   = LDrawParser(ldraw_path=LDRAW_PARTS_ROOT)

    peg_dat  = peg_id  if peg_id.lower().endswith(".dat")  else f"{peg_id}.dat"
    hole_dat = hole_id if hole_id.lower().endswith(".dat") else f"{hole_id}.dat"

    # 插销：沿主轴切片
    peg_profile = geo_proc.get_cross_section_profile(peg_dat, axis=0, num_slices=40)
    if not peg_profile:
        return {"error": f"无法提取 {peg_id} 几何"}

    extents  = [peg_profile["bbox_max"][i] - peg_profile["bbox_min"][i] for i in range(3)]
    peg_axis = int(np.argmax(extents))
    if peg_axis != 0:
        peg_profile = geo_proc.get_cross_section_profile(peg_dat, axis=peg_axis, num_slices=40)

    # 梁孔：从端口的插入轴（Z 轴）推断孔深；不再硬编码 hole_axis = 1
    hole_ports    = parser.parse_dat_file(hole_dat)
    peghole_ports = [p for p in hole_ports if 'hole' in p.port_type]
    beam_thickness = 20 * LDU

    if len(peghole_ports) >= 2:
        # 两个端口沿孔轴分布；利用归一化后的插入轴（Z 轴）投影差值计算孔深
        ins_axis = peghole_ports[0].insertion_axis
        diff_vec = peghole_ports[0].position - peghole_ports[1].position
        beam_thickness = abs(float(np.dot(diff_vec, ins_axis)))
        if beam_thickness < 1e-6:
            # 插入轴投影为零时降级：取欧式距离
            beam_thickness = float(np.linalg.norm(diff_vec))

    # hole_axis 仍保留在响应 dict 中供调试（现在用主插入轴最大分量推算）
    hole_axis = int(np.argmax(np.abs(peghole_ports[0].insertion_axis))) if peghole_ports else 1

    # 从 peghole.dat 提取精确孔内径
    hole_radius  = None
    peghole_verts = geo_proc.extract_geometry("peghole.dat")
    if peghole_verts[0]:
        pv           = np.array(peghole_verts[0])
        xz_dists     = np.sqrt(pv[:, 0]**2 + pv[:, 2]**2)
        unique_radii = sorted(set(np.round(xz_dists, 1)))
        if unique_radii:
            hole_radius = float(unique_radii[0]) * LDU
    if not hole_radius:
        hole_radius = 6 * LDU

    # 逐切片判断配合（使用参数化公差代替旧的乘法阈值）
    peg_radii     = peg_profile["radii"]
    peg_positions = peg_profile["axis_positions"]
    peg_length    = peg_positions[-1] - peg_positions[0] if peg_positions else 0

    fit_types = []
    for r in peg_radii:
        delta = r - hole_radius
        if delta <= 0.0:
            fit_types.append("clearance")
        elif delta <= DELTA_FRICTION_MAX:
            fit_types.append("friction")
        else:
            fit_types.append("blocked")

    can_pass    = [ft != "blocked" for ft in fit_types]
    max_run     = current_run = 0
    for cp in can_pass:
        current_run = current_run + 1 if cp else 0
        max_run = max(max_run, current_run)

    slice_step    = peg_length / max(len(peg_positions) - 1, 1)
    max_passable  = max_run * slice_step
    can_fully_insert = max_passable >= beam_thickness

    overall_fit = "clearance"
    for ft in fit_types:
        if ft == "blocked":
            overall_fit = "blocked"
            break
        if ft == "friction" and overall_fit == "clearance":
            overall_fit = "friction"

    peg_max_r       = max(peg_radii) if peg_radii else 0
    interference    = peg_max_r - hole_radius
    interference_pct = (interference / hole_radius * 100) if hole_radius > 0 else 0

    result = {
        "peg_id":               peg_id,
        "hole_id":              hole_id,
        "peg_axis":             peg_axis,
        "hole_axis":            hole_axis,
        "peg_length":           round(peg_length, 6),
        "hole_radius":          round(hole_radius, 6),
        "peg_min_radius":       round(min(peg_radii) if peg_radii else 0, 6),
        "peg_max_radius":       round(peg_max_r, 6),
        "beam_thickness":       round(beam_thickness, 6),
        "max_passable_length":  round(max_passable, 6),
        "can_fully_insert":     can_fully_insert,
        "fit_type":             overall_fit,
        "interference_mm":      round(interference * 1000, 3),
        "interference_pct":     round(interference_pct, 1),
        "optimal_center_offset": 0.0,
        "method":               "mesh_slice",
    }

    logger.info(
        f"[网格切片] 插入检测: {peg_id} → {hole_id}\n"
        f"  配合类型: {fit_desc.get(overall_fit, overall_fit)}\n"
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
