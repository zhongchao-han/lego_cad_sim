# 搜索与大模型代理层 QA 测试规范 (QA Search Test Plans)

按照 TDD（测试驱动开发）指导思想，以下核心场景已被正式引入到项目 `frontend\src\hooks\usePartSearch.test.tsx` 中，并作为 `npm run test` 在 CI 中进行强制卡点验证。

## 单元测试覆盖矩阵 (Unit Test Coverage)

### 场景 1: 从配置工厂热读取存活域 (Initialization)

*   **测试名**: 1. Initializes LLM config from localStorage correctly.
*   **输入/模拟环境**:
    在组件挂载前，预先 `localStorage.setItem('lego_llm_config', {enabled: true, apiKey: 'sk-mock'...})`。
*   **断言目标边界**:
    *   拦截器是否直接取出了配置对象。
    *   断言 `result.current.llmConfig.enabled` === `true`。

### 场景 2: 授权失败的断裂降级 (Unauthorized Gateway Error)

*   **测试名**: 2. Requires API Key if LLM is enabled and natural language is detected.
*   **输入/模拟环境**:
    设置 `apiKey: ''` 空串（未配钥匙），调用 `setQuery('红色大板')` 构造触发语义的参数。
*   **断言目标边界**:
    *   大模型不得以错误的空 Header 连击远端服务器造成封防发散。
    *   本地强同步抛出异常。
    *   系统捕捉到底层抛出的强错误栈，渲染在 UI 下方。
    *   断言 `result.current.error` 必含字眼 "未配置大模型 API Key"。

### 场景 3: “非必需，不调用”的精简分流 (LLM Proxy Skipping)

*   **测试名**: 3. Successfully bypasses LLM if search is completely English and short.
*   **输入/模拟环境**:
    用户输入规范官方用词 `plate`。即便此时开关 `enabled: true`，API Key 完全可用。
*   **断言目标边界**:
    *   探针监测 LLM fetch 次数（`fetchMock.toHaveBeenCalledTimes`）必须严格为 `1` 次（那 1 次是发给服务器的 Meili 鉴权，不是给大模型的）。
    *   引擎直接使用 LDraw 原生语法走穿到底层 MeiliSearch。
    *   断言检索结果状态 `isLoading` 顺利恢复 `false` 且不阻断。

### 场景 4: MeiliSearch 搜索引擎主核宕机 (Disaster Recovery)

*   **测试名**: 4. Handles MeiliSearch initialization failure gracefully.
*   **输入/模拟环境**:
    将 `/api/search/key` 的后端服务端点掐断（Mock 为 `Internal Server Error`，`ok: false`）。
*   **断言目标边界**:
    *   前端绝不抛黄屏/崩溃页。
    *   倒换默认降级 UI，阻断所有深层次动作。
    *   断言包含友好人机交互文本 "无法连接到搜索引擎"。

## UI 人工 E2E 探索式用例 (E2E Manual Exploratory)

对于未做自动化覆盖但对用户侧极其核心的内容，推荐人工走查：
1. **缩略图路径匹配（曾抛出 BUG 的场景）**：
    *   验证通过同义词联想到的结果中，例如 `39369` 的结果项左侧能够完整挂载 CDN `19x11 大板`实物图，无失效（broken）的占位黑框。
2. **预览视图联动拉起体验**：
    *   触发组合键 `Cmd+K`。
    *   输入搜索字元等候。
    *   鼠标点击搜索菜单结果项后，检测菜单自身能否立刻平滑关闭。
    *   检测组件能否通过 zustand 被悬浮至主视觉轴（View Center）呈现 3D 切割预览模型，并同步归入下方的 staging 待组装底栏。
