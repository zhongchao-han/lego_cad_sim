# LEGO Technic CAD & Physics Simulation 架构知识中心

本文档树是本系统的唯一知识源（Single Source of Truth）。系统划分为前端装配、后端状态机与物理网关、图论拓扑计算核心三大域。

## 📖 目录树导航体系

- **00_project_management**: 版本路线与迭代管理
- **01_product_requirements**: 业务愿景与交互用例
- **02_system_design**: 逻辑架构设计、底层算法图与拓扑结构规约
- **03_data_flow_and_physics**: 数据链路追踪与 PyBullet 微秒物理核微网隔离
- **04_quality_and_testing**: QA 测试用例规范、覆盖率要求及质量熔断防线
- **05_toolchain_and_infrastructure**: 本地开发者测试工具链、模拟器与 CI 设施图纸
- **06_engineering_standards**: 核心工程规约红骨架（Coding、API双边契约、可观测性埋点）

> **[!] 高优工程底线**
> 本仓库崇尚“代码即艺术”。所有进入 Main/Trunk 树的 Pull Request，必须严苛遵循 `06_engineering_standards` 下的纪律要求（包含 TypeScript 零 any，Python 首位类型提示，全覆盖日志跟踪），否则 CI 不予通过，拦截合入请求。
