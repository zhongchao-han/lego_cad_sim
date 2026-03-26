# 贡献者指南 (Contributing to LEGO CAD Simulation)

欢迎您向这个具有拓扑驱动和严肃物理内核的项目贡献代码！为了维持超高维度的代码质量与纯粹可读性，项目设立了无妥协的防腐屏障。请务必完整阅览。

## 1. 入库红线协议 (MANDATORY RULES)

- **没有任何一块功能代码是不需要写测试的。** 我们遵循测试驱动开发（TDD）哲学。在您提交业务代码块之前，您被要求提供能覆盖该功能正向及恶劣边界分支的 Test Case 文件。
- **类型安全是一切。**
    - 在 Python 后端中：一切函数皆带有极具约束力的 Type Hints。您必须确保本地运行 `mypy --strict` 通过。
    - 在 TS 前端中：向后兼容或偷懒的 `any` 声明是违法的规避手段，您的代码无法被 Merge。

## 2. 局部开发与运行沙盒

在开始修改代码之前，请查阅以下两份核心开发档：
- [后端: API 与 WebSocket 设计准则](docs/06_engineering_standards/02_api_and_websocket_contract.md) 
- [架构: 系统代码与规范](docs/06_engineering_standards/01_coding_and_architecture_guidelines.md)

### 2.1 准备就绪
拉取代码并在两端安装依赖库。请确保基于 Python 3.10+ 环境：
`pip install -r requirements.txt` / `npm install`

### 2.2 测试全集
提交（Commit）之前，请在您本地的工作台使用如下命令执行全链路健康拨测：
- **Backend**: `pytest tests/ -v --mypy`
- **Frontend**: `npm run test`

## 3. Git Commit Message 规范

拒绝任何毫无意义的 "fix" 或者 "update file"。请强制实行 Conventional Commits 标准协议：
- `feat(topology)`: 添加拓扑打断的新功能
- `fix(fastapi)`: 修复了端点因为反序列化造成的 500
- `refactor(physics)`: 优化重构物理碰撞步长的硬核代码
- `docs(repo)`: 增加了此页的贡献者档案
