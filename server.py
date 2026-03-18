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

    # 用 Port 工厂方法构建强类型端口；未知类型会打印日志并报错
    port_p = Port.create_from_ldraw(
        f"p_{req.parent_id}", req.port_type_p,
        np.array(req.parent_origin), p_rot,
        part_context=req.parent_id
    )
    port_c = Port.create_from_ldraw(
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

    # ---- 2) 严格模式：拒绝降级到几何切片 -----------------------------
    logger.critical(
        f"\n{'!'*60}\n"
        f"STRICT INSERTION CHECK FAILED: 物理接口定义缺失!\n"
        f"尝试检测: {peg_id} ({peg_type})  VS  {hole_id} ({hole_type})\n"
        f"状态: 系统拒绝使用不可调教的几何切片进行模糊猜测。\n"
        f"修复建议: 请在 connection_interface.py 的注册表中添加这些原件的参数化(Radius/Depth/Fit)。\n"
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
