# Changelog (变更日志)

本文件系统记录 LEGO Technic CAD & Physics Simulation 的历代演进变迁。我们严格遵循 [Semantic Versioning (语义化版本号)](https://semver.org/)，任何重要缺陷修补、特性新增或重磅架构破坏均详细溯源于此，以替代将版本号烙入单体文档名的旧反模式。

## [Unreleased]

### Added (新增设施)
- **多独立组网拓扑 (Multi-Group Topology)**: 彻底解除 UI 侧对“场景第二零件必须吸附”的强制束缚。打通 `FREE_PLACING` 幽灵抛掷链路，允许用户从零件库引入全新基底零件并直接放置在网格地面上，形成无限数量并行共存的连通分量孤岛。
- **文档体系重塑**: 完全整编重构 `docs` 结构，摒除目录脱胶及文件名硬编码强耦合版号的历史遗留，新建 `06_engineering_standards` 列明全高优防穿模工程红线规约。
- **防御架构规范**: 确立静态分析的不可触犯界限（TS 强检、后端 mypy），并起草了全周期的调试与埋点 Logging 制约。

### Changed (升级与重构改动)
- **交互层级逆转 (Drill-Up Selection)**: 将 3D 视口内点击零件的默认选中状态从 `GROUP` 变更为 `INDIVIDUAL`。二次点击同一零件时再扩张选区至 `GROUP`，以“一击微观，二击宏观”的极简交互取代繁冗的选区坍缩逻辑，极大提高了插销等微小零件的点选效率。

---

## [v3.1.0] - 先前迁移整合

### Changed (升级与重构改动)
- **Site-Based Topology (基于接口位置的拓扑图)**: 迁移至 v3.1 架构。核心变更包含后端 Auto-Latch Scanner，侦测并收敛注册符合几何规范的 LEGO 孔洞点位。
- **Quality Assurance**: 追加了跨维度的 Integration 及 Store Mock Tests，堵住接口通信空隙带来的黑盒状态崩溃。

### Fixed (缺陷与崩溃堵截)
- **GLB Asset Generation Bug**: 排查并歼灭了在 `GeometryProcessor.convert_to_glb()` 解析层因为数据载荷不对齐触发的 runtime TypeError，并补设单元网验证。
- **Port Snapping Glitch**: 针对特定吸附面产生的空间坐标误吸问题，通过修复 Snap 选点映射关系解决误对齐。

---

## [v1.2.0] - 历史构建

### Added
- 基础的三维深空环境，及原始零件组装交互方案确立（见 interaction specs）。
- 前置 Ldraw `.dat` 模型分析解包支持。

*(The changelog starts tracking correctly mapped architectures from this point onwards. Historical hardcoded documentation has been incorporated.)*
