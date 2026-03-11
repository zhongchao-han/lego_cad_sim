import asyncio
import json
import logging
import os
from typing import Dict, Any, Optional, List

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# 我们假设在前期已建立前述各底层引擎
from physics_engine import PhysicsEngine
from topology_manager import TopologyManager, PartNode, ConnectionEdge
from ldraw_parser import LDrawParser
from geometry_processor import GeometryProcessor
from fastapi.staticfiles import StaticFiles

logging.basicConfig(level=logging.INFO, format='%(levelname)s: %(message)s')
logger = logging.getLogger(__name__)

# --- 服务实体与配置 ---

app = FastAPI(title="LEGO Technic Simulation Backend", version="1.0.0")

# 配置 CORS，允许基于 React (常用 3000 或 Vite 的 5173 等) 前端跨域请求
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 线上环境必须限定
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 后端单例驱动装载体
engine = PhysicsEngine(mode="DIRECT")  # Web 模式下我们关闭本地 UI 避免卡死，纯靠 Three.js 渲染
topo_manager = TopologyManager()

# 系统模式状态："ASSEMBLY" (零重力组装拓扑) OR "SIMULATION" (有重力实时物理计算)
system_mode = "ASSEMBLY"
engine.toggle_gravity(False)  # 开箱即为组装漂浮状态

# LDraw 几何与端口数据根目录（由用户在本地配置真实 LDraw 库）
LDRAW_PARTS_ROOT = os.environ.get("LDRAW_PARTS_ROOT", os.path.join(os.getcwd(), "ldraw_lib"))
MESH_CACHE_ROOT = os.path.join(os.getcwd(), "ldraw_meshes")

# 挂载静态文件服务供前端访问 GLB
os.makedirs(MESH_CACHE_ROOT, exist_ok=True)
app.mount("/ldraw_meshes", StaticFiles(directory=MESH_CACHE_ROOT), name="ldraw_meshes")

# --- API 数据模型定义 ---

class SnapRequest(BaseModel):
    parent_id: str
    child_id: str
    port_type_p: str
    port_type_c: str
    # Transform matrices/positions 为简便省略成 flat array，真实使用中需要解析 3x3
    parent_origin: list
    parent_rot: list  # [9 元素] 
    child_origin: list
    child_rot: list   # [9 元素]

class ForceRequest(BaseModel):
    link_name: str
    force: list # [Fx, Fy, Fz]
    position: list = [0, 0, 0]


class LDrawPort(BaseModel):
    type: str
    position: list
    rotation: list


class LDrawPartResponse(BaseModel):
    part_id: str
    ports: List[LDrawPort]
    mesh_url: Optional[str] = None

# --- 核心业务 API (RESTful 端点) ---

@app.post("/api/toggle_mode")
async def toggle_mode(mode: str):
    """前端点击 UI '开始仿真' 或 '回到编辑' 触发"""
    global system_mode
    mode = mode.upper()
    
    if mode == "SIMULATION":
        if system_mode != "SIMULATION":
            # 停止编辑，打包现在的网络并下达给物理引擎
            logger.info("接受前端指令，开始转化拓扑并生成 URDF ...")
            tree = topo_manager.build_spanning_tree()
            urdf_path = "current_assembly.urdf"
            topo_manager.export_urdf(tree, urdf_path)
            
            # 重新实例化并启动当前图谱物理引擎
            engine.disconnect()
            engine.__init__(mode="DIRECT")
            
            success = engine.load_assembly(urdf_path)
            if success:
                # 把之前闭环打断的地方强制绑回来
                for loop in topo_manager.closed_loops:
                    engine.add_closed_loop_constraint(loop.parent_id, loop.child_id)
                
                engine.toggle_gravity(True)
                system_mode = "SIMULATION"
                return {"status": "success", "msg": "Simulation started."}
            else:
                return {"status": "error", "msg": "URDF load failed."}
                
    elif mode == "ASSEMBLY":
        if system_mode != "ASSEMBLY":
            # 返回装配状态，拆除并解除引力，重置回 NetworkX 中心编辑
            engine.toggle_gravity(False)
            system_mode = "ASSEMBLY"
            return {"status": "success", "msg": "Returned to assembly editor."}
            
    return {"status": "ok", "msg": "No changes made."}


@app.get("/api/ldraw_part/{part_id}", response_model=LDrawPartResponse)
async def get_ldraw_part(part_id: str):
    """
    为前端提供指定 LDraw 部件的语义端口和网格引用。
    """
    # 简单的 part_id -> dat 文件映射规则
    dat_filename = part_id if part_id.lower().endswith(".dat") else f"{part_id}.dat"

    parser = LDrawParser(ldraw_path=LDRAW_PARTS_ROOT)
    geo_proc = GeometryProcessor(ldraw_path=LDRAW_PARTS_ROOT)

    ports = []
    # 使用增强后的解析器，支持递归搜索
    parsed_ports = parser.parse_dat_file(dat_filename)
    if parsed_ports:
        ports = [LDrawPort(**p.to_dict()) for p in parsed_ports]
    else:
        logger.warning(f"LDraw 源文件未找到或未解析出端口: {dat_filename}")

    # 处理几何转换
    glb_filename = f"{part_id}.glb"
    glb_path = os.path.join(MESH_CACHE_ROOT, glb_filename)
    
    if not os.path.exists(glb_path):
        logger.info(f"触发动态转换: {dat_filename} -> {glb_filename}")
        geo_proc.convert_to_glb(dat_filename, glb_path)

    # 约定 mesh_url：供前端使用 three.js / R3F 的 GLTF/GLB 加载器加载真实高模网格
    mesh_url = f"/ldraw_meshes/{glb_filename}"

    return LDrawPartResponse(
        part_id=part_id,
        ports=ports,
        mesh_url=mesh_url,
    )

@app.post("/api/snap_parts")
async def snap_parts(req: SnapRequest):
    """接受来自用户在画布中拖拽发生 Snapping (吸附)后的事件，写入拓扑"""
    import numpy as np
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


@app.post("/api/apply_force")
async def apply_force(req: ForceRequest):
    """前端鼠标拖拽目标（通过 Raycast）给对应对象挂载作用力"""
    if system_mode == "SIMULATION":
        engine.apply_user_force(req.link_name, req.force, req.position)
        return {"status": "success"}
    return {"status": "ignored", "msg": "System must be in SIMULATION mode to apply physics forces."}

# --- WebSocket 实施 (状态流推送到 React-Three-Fiber) ---

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
        # Create a copy of the list to iterate over, since we might remove items
        for connection in list(self.active_connections):
            try:
                await connection.send_text(message)
            except Exception as e:
                logger.warning(f"Failed to send to a client, removing from pool: {e}")
                self.disconnect(connection)

manager = ConnectionManager()

@app.websocket("/ws/physics_stream")
async def physics_stream(websocket: WebSocket):
    """
    负责在装配及仿真态持续下发 60Hz 的状态数据。
    """
    await manager.connect(websocket)
    try:
        while True:
            # 等待一个帧刷新间隔，适配大多数显示屏 60 Hz 即可 (减少 Web 性能开销，内部计算仍保持维持 240Hz精度)
            await asyncio.sleep(1/60.0)
            
            # 后台物理演算钟走格子（为了符合 240Hz 处理精度，60Hz推流即说明一次推流前进4个物理步）
            if system_mode == "SIMULATION":
                for _ in range(4):
                    engine.step()
            
            # 收取当前三维空间的绝对位姿
            state = engine.get_state()
            if state:
                # 下发 { "base": { position:[], quaternion:[] }, "link_name_x": {...} }
                payload = json.dumps({"mode": system_mode, "state": state})
                await manager.broadcast(payload)
                
    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception as e:
        logger.error(f"WebSocket 数据流中断或抛出异常: {e}")
        manager.disconnect(websocket)


# =========================== Unit testing execution ============================
if __name__ == "__main__":
    import uvicorn
    # 直接以此脚本进入点拉起 ASGI 服务器，端口设于 8000
    print("\n[Phase 4: FastAPI & WebSocket Backend 已准备就绪]")
    uvicorn.run(app, host="0.0.0.0", port=8000)
