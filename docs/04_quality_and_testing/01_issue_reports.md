# LEGO CAD 仿真系统：质量核验问题报告 (Issue Report v3.1)

## 1. 环境联调问题：CORS 跨源拦截 (Blocked by CORS Policy) - [已修复 ✅]

### **现象描述**
在执行浏览器端全链路测试时，前端（通常运行在 `http://localhost:5173` 或 `5174`）尝试调用后端 API（`http://127.0.0.1:8000`）获取零件库列表。由于后端 `CORSMiddleware` 的 `allow_origins` 列表中未包含当前前端运行的确切端口（如 `5174`），导致浏览器出于安全策略拦截了所有 AJAX 请求。

### **受影响的功能**
- **零件库预览**: "No verified parts found"，无法从库中拖出零件。
- **库核验页面**: 零件列表加载失败 (`TypeError: Failed to fetch`)。
- **零件吸附 (Snap)**: 因无法获取预览零件，无法进行全流程验证。

### **复现步骤**
1. 启动后端：`python -m backend.server`
2. 启动前端：`npm run dev`（若 5173 被占用，Vite 会自动切换到 5174）
3. 打开控制台，观察 `api/get_verified_parts` 报错：`Access to XMLHttpRequest has been blocked by CORS policy`.

### **修复状态**
已在 `backend/server.py` 中更新 `allow_origins`，支持 `localhost:5174`。经过浏览器实测，Material Library 现在能正常加载零件列表。

## 2. 交互与拓扑 (待验证项)
由于 CORS 阻塞，以下 Test Case 尚未能通过自动化浏览器脚本完成：
- **Test 3.1: P2P 绝对精准落位**
- **Test 4.1: 轴向移动阻连**
- **Test 4.3: 动态视觉反馈一致性**
