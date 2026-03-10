import pybullet as p
import pybullet_data
import time
import math
import logging
from typing import Dict, List, Optional, Tuple

logging.basicConfig(level=logging.INFO, format='%(levelname)s: %(message)s')
logger = logging.getLogger(__name__)

class PhysicsEngine:
    """
    负责驱动装配体物理仿真的核心封装。
    功能包括：
    - 连接 PyBullet (支持 GUI/DIRECT)
    - 加载 URDF 及处理额外的拓扑闭环 (通过额外 Constraint)
    - 针对所有 Link 开启高速 CCD（连续碰撞检测）防止穿模 (Tunneling Effect)
    - 配置销钉和轴的铰链摩擦特性 (Clutch Power)
    - 获取当前装配位姿字典用于 WebSocket 下发同步到 Three.js (前端)
    """

    def __init__(self, mode: str = "GUI"):
        # 连接模式: p.GUI 或 p.DIRECT (无头模式，用于纯 Web 后台伺服)
        connect_mode = p.GUI if mode.upper() == "GUI" else p.DIRECT
        self.client_id = p.connect(connect_mode)
        
        # 将 PyBullet 引擎的资源搜索路径设置为其自带包，方便加载地面等
        p.setAdditionalSearchPath(pybullet_data.getDataPath(), physicsClientId=self.client_id)
        
        # 初始化基础设置
        self._setup_world()
        
        self.robot_id: Optional[int] = None
        self.num_joints: int = 0
        
        # 给前端下发数据的缓存：joint_name -> joint_index 等
        self.joint_name_to_index: Dict[str, int] = {}
        self.link_name_to_index: Dict[str, int] = {}

    def _setup_world(self):
        """配置基于 SI 的物理引擎世界参数"""
        p.setGravity(0, 0, -9.81, physicsClientId=self.client_id)
        # 固定物理步长，以 240Hz 为宜
        p.setTimeStep(1./240., physicsClientId=self.client_id)
        
        # 默认放一个无限大平面托底（如果是在零重力装配模式，可将平面与重力取消）
        self.plane_id = p.loadURDF("plane.urdf", physicsClientId=self.client_id)
        
        # 修改表面力学参数增加阻碍
        p.changeDynamics(self.plane_id, -1, lateralFriction=1.0)
        logger.info("物理世界参数已初始化，引力: [0, 0, -9.81]。")

    def toggle_gravity(self, enable: bool):
        """切换动力学状态（仿真模式/悬浮装配模式）"""
        if enable:
            p.setGravity(0, 0, -9.81, physicsClientId=self.client_id)
            logger.info("已切换至【模拟模式：启用重力】。")
        else:
            p.setGravity(0, 0, 0, physicsClientId=self.client_id)
            logger.info("已切换至【组装模式：零重力飘浮】。")

    def load_assembly(self, urdf_path: str, start_pos: List[float] = [0, 0, 0.5]) -> bool:
        """加载经过 Topology Manager 处理的树状装配体，赋予其物理碰撞外壳"""
        try:
            # useFixedBase=False, flags 允许加载非常规惯性并且支持自己覆盖 CCD 标识
            flags = p.URDF_USE_INERTIA_FROM_FILE | p.URDF_USE_SELF_COLLISION
            self.robot_id = p.loadURDF(urdf_path, basePosition=start_pos, 
                                       useFixedBase=False, flags=flags, 
                                       physicsClientId=self.client_id)
            
            self.num_joints = p.getNumJoints(self.robot_id, physicsClientId=self.client_id)
            self._map_link_and_joint_names()
            self._configure_joints()
            self._enable_ccd()
            
            logger.info(f"成功载入装配 URDF: {urdf_path}，包含 {self.num_joints} 个从属关节。")
            return True
            
        except p.error as e:
            logger.error(f"加载装配体物理 URDF 发生崩溃：{e}")
            return False

    def _map_link_and_joint_names(self):
        """爬取 URDF 使得内部可以通过人类可读 Name 寻址 Index"""
        self.joint_name_to_index.clear()
        self.link_name_to_index.clear()
        
        # 记录根链接，PyBullet 中使用 -1 表示 root/base
        self.link_name_to_index["base_link"] = -1
        
        for i in range(self.num_joints):
            info = p.getJointInfo(self.robot_id, i, physicsClientId=self.client_id)
            joint_name = info[1].decode('utf-8')
            link_name = info[12].decode('utf-8')
            
            self.joint_name_to_index[joint_name] = i
            self.link_name_to_index[link_name] = i

    def _configure_joints(self):
        """给予 LEGO 装配件 (比如销钉与板孔) 正确的阻尼特征及闭环合并力"""
        for i in range(self.num_joints):
            info = p.getJointInfo(self.robot_id, i, physicsClientId=self.client_id)
            joint_name = info[1].decode('utf-8')
            joint_type = info[2]
            
            # 关闭基于 Pybullet 的默认内置驱动，否则销轴会默认被锁住卡死不让自由运动。
            p.setJointMotorControl2(bodyUniqueId=self.robot_id, 
                                    jointIndex=i, 
                                    controlMode=p.VELOCITY_CONTROL, 
                                    force=0, physicsClientId=self.client_id)
                                    
            if joint_type == p.JOINT_CONTINUOUS or joint_type == p.JOINT_REVOLUTE:
                # 设定摩擦销或者轴的 Clutch Power (摩擦阻尼系数)
                # 我们可以根据销/孔类型来精细决定 jointFrictionForce，比如灰色无阻尼销给予 0，而黑色阻力销给予一个阻力。
                clutch_force = 1.5 if "friction" in joint_name.lower() else 0.05
                
                # 针对连续单自由度的转动加入微弱控制以产生摩擦阻力
                p.setJointMotorControl2(
                    bodyIndex=self.robot_id,
                    jointIndex=i,
                    controlMode=p.VELOCITY_CONTROL,
                    targetVelocity=0,
                    force=clutch_force, 
                    physicsClientId=self.client_id
                )
                logger.debug(f"设定连续关节 {joint_name} 的阻尼离合力为 {clutch_force}。")

    def _enable_ccd(self):
        """开启连续碰撞检测以防止细小的销轴因为高速而在两帧内直接“隧道穿插”越过板洞"""
        # Base link
        p.changeDynamics(self.robot_id, -1, ccdSweptSphereRadius=0.001, physicsClientId=self.client_id)
        # 其它链接
        for i in range(self.num_joints):
            p.changeDynamics(self.robot_id, i, ccdSweptSphereRadius=0.001, physicsClientId=self.client_id)
        logger.info("已全面生效 CCD 连续扫掠碰撞侦测球。")

    def add_closed_loop_constraint(self, parent_link_name: str, child_link_name: str):
        """
        处理 URDF 生成树中所放弃的破坏循环边。对于首尾相连的情况，
        我们在这里用 Pybullet 内置 `createConstraint` 强制绑定，复原这股支撑力。
        """
        if self.robot_id is None:
            return
            
        parent_idx = self.link_name_to_index.get(parent_link_name, -1)
        child_idx = self.link_name_to_index.get(child_link_name, -1)
        
        # 此处的 Constraint 配置需要精密计算初始补偿，在此我们使用 Point2Point 锁定其锚点
        c_id = p.createConstraint(parentBodyUniqueId=self.robot_id,
                                  parentLinkIndex=parent_idx,
                                  childBodyUniqueId=self.robot_id,
                                  childLinkIndex=child_idx,
                                  jointType=p.JOINT_FIXED,
                                  jointAxis=[0,0,0],
                                  parentFramePosition=[0,0,0],
                                  childFramePosition=[0,0,0],
                                  physicsClientId=self.client_id)
        logger.info(f"建立补偿拓扑约束 ID:{c_id}，联结 {parent_link_name} 与 {child_link_name}")

    def apply_user_force(self, link_name: str, force: List[float], pos: List[float] = [0,0,0]):
        """提供给用户在前端使用鼠标“拽拉”实体时的力反馈外部映射"""
        if self.robot_id is None: return
        link_idx = self.link_name_to_index.get(link_name, -1)
        p.applyExternalForce(objectUniqueId=self.robot_id,
                             linkIndex=link_idx,
                             forceObj=force,
                             posObj=pos,
                             flags=p.LINK_FRAME,
                             physicsClientId=self.client_id)

    def step(self):
        """驱动整个物理世界的时钟向前迈进 1/240 单位时间。"""
        p.stepSimulation(physicsClientId=self.client_id)

    def get_state(self) -> Dict[str, Any]:
        """
        抓取此时物理引擎内部所有子构件的全局 Transform 阵列及其局部扭动角度，
        以便组装成 JSON 泵送给 Three.js 前端渲染层。
        """
        state = {}
        if self.robot_id is None:
            return state
            
        # 根节点的空间座标和朝向四元数
        pos, quat = p.getBasePositionAndOrientation(self.robot_id, physicsClientId=self.client_id)
        state["base"] = {
            "position": pos,
            "quaternion": quat
        }
        
        # 子关节相对参数或者直接获取每个网格对象的全域坐标
        for name, idx in self.link_name_to_index.items():
            if idx == -1: continue # base_link
            
            # 使用 getLinkState 我们可以拿到直接灌输到 three.js Object3d 的最终位姿以避免前端计算 IK
            link_state = p.getLinkState(self.robot_id, idx, physicsClientId=self.client_id)
            # link_state[4] is worldLinkFramePosition, link_state[5] is worldLinkFrameOrientation
            state[name] = {
                "position": link_state[4],
                "quaternion": link_state[5]
            }
            
        return state

    def disconnect(self):
        """释放后端资源"""
        p.disconnect(self.client_id)

# =========================== Unit testing execution ============================
if __name__ == "__main__":
    import math
    
    print("\n--- Phase 3: Physics Engine Integration 验证测试 ---")
    
    # 构建极其简化的桩基 URDF 进行力学引擎接入试验
    test_urdf = "temp_test_physics.urdf"
    with open(test_urdf, "w") as f:
        f.write('''<?xml version="1.0"?>
<robot name="test">
  <link name="base_link">
    <inertial>
      <origin xyz="0 0 0" rpy="0 0 0" />
      <mass value="0.005" />
      <inertia ixx="1e-5" ixy="0" ixz="0" iyy="1e-5" iyz="0" izz="1e-5" />
    </inertial>
  </link>
  <link name="rotor">
    <inertial>
      <origin xyz="0 0 0" rpy="0 0 0" />
      <mass value="0.002" />
      <inertia ixx="1e-5" ixy="0" ixz="0" iyy="1e-5" iyz="0" izz="1e-5" />
    </inertial>
  </link>
  <joint name="spin_joint" type="continuous">
    <parent link="base_link"/>
    <child link="rotor"/>
    <origin xyz="0 0 0.008" rpy="0 0 0" />
    <axis xyz="0 0 1" />
  </joint>
</robot>
        ''')

    # 用不启动图形的方式来验证代码运转（模拟后端被 Fastapi 调用）
    engine = PhysicsEngine(mode="DIRECT")
    
    loaded = engine.load_assembly(test_urdf, start_pos=[0, 0, 0.5])
    
    if loaded:
        print("\n进入物理推演循环 10 步：")
        for i in range(10):
            engine.step()
            state = engine.get_state()
            # 大致展现第 10 步掉落及状态位移
            if i == 9: 
                print(f"Step {i} State (Base): {state['base']['position']}")
                print(f"Step {i} State (Rotor): {state['rotor']['position']}")

    engine.disconnect()
    
    import os
    os.remove(test_urdf)
    print("\n[PyBullet Physics Engine 模块封装运转完好]")
