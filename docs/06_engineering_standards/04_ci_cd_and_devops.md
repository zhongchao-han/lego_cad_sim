# 04. 持续集成与部署架构规约 (CI/CD & DevOps Strategy)

物理引擎系统的环境依赖极度严苛。本系统需要使用 Docker 容器化来抹平部署侧的一切运行库（如底层 NumPy 等 C 依赖库）的不一致问题。

## 一、 Docker 架构与构建

- 本系统应分别采用 `frontend/Dockerfile` 和 `backend/Dockerfile` 构建双核镜像。
- 后端运行时环境必须严格冻结（如基于 `poetry.lock` 或 `requirements.txt` 硬锁住 `pybullet`, `scipy` 版本）。
- 部署模式采用 Docker Compose 统一托管起步，并限定资源配额（如物理核的并行可用度）。

## 二、 CI 门禁红线 (Gatekeeper)

任何 PR 提交到 Main 分支前，必须经由 GitHub Actions 执行以下硬核检查流水线：
1. **静态代码层 (The Linter Wall)**：
   - 前端：执行 `npm run lint` 和 `npm run typecheck`。有异常或 `any` 注入立即中止合并。
   - 后端：执行 `ruff check .` 和 `mypy backend --strict`。
2. **测试覆盖穹顶 (Coverage Vault)**：
   - 使用 `pytest --cov=backend` 和 `vitest run --coverage`，单元测试如果 Coverage 跌落设定的安全水位线（如 85%），立刻驳回代码。
3. **物理引擎沙盒验证 (Sandbox Build Check)**：
   - 构建临时沙盘环境尝试导入、测试图论图割（BFS）、并运转 1 秒内推演算，测证核心链路未遭破坏。
