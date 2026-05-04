# 02. API 与高刷数传契约引擎 (API & WebSocket Contract)

本规约约束本系统复杂的 60Hz 及以上速率传输网格，以及基础的状态控制请求界面。防范网络 I/O 的任何错位与不可靠导致客户端瘫痪。

## 一、 WebSocket 实时推流防线协议

本项目存在大量 `pybullet` 同步出的四元数+位移推流，协议层防线设定如下：
1. **防抖与缓冲环**：
   - 由于 WebSocket 是无序且可能黏包的，每次报文必须携带单调递增的 `sequence_id` 或 `timestamp_ms`。前端在接管物理帧时，如果捕捉到过期废帧（`frame_id < current_painted_frame`）必须予以丢弃，坚决不可使物体呈现空间位置倒退及诡异闪烁。
2. **包体序列化严控 (Serialization Strictness)**：
   - 由于数据流大，传输层采取压缩数组模式。通信规约中，如位置 `[x, y, z]`、四元数 `[x, y, z, w]` 必须以严格的定长 Float32Array 发送至前端解构。

## 二、 RESTful HTTP 状态变异接口规范

1. **统一包装响应载荷 (Response Envelope)**：
   每一次接口调用均须通过标准化格式返传，严禁用原生的 List 或 Dict 直接敷衍脱光丢给对端：
   ```json
   {
      "success": true,
      "code": 200,
      "payload": { ... },
      "error_trace": null,
      "meta": { "latency_ms": 12, "request_id": "req-1x2y3z" }
   }
   ```
2. **防御性前置过滤网 (Pre-condition Checks)**：
   永远不要信任前端参数。所有参数必须在 Pydantic 层得到校验：数值域（限制上下界）、非空状态、甚至是 UUID 的格式是否合法。若有违背立刻拦截抛出 400 不予向内部传递。

## 三、 Idempotency Key（变异端点防重入）

针对 `snap_parts` 等改动 `MultiDiGraph` / 物理状态的 POST 端点，骨干设计如下：

1. **客户端约定**：
   - 每次发起 mutating POST 时生成一个 UUIDv4，塞进 `Idempotency-Key` request header。
   - 若 axios / fetch 在网络层重发（重试中间件、浏览器自动重连、用户双击），同一逻辑请求**必须复用同一个 key**，不得每次重发都换新 key。
2. **服务端契约**（实现见 `backend/idempotency.py`）：
   - 同 key + 同 body → 直接回放上次响应，附 `Idempotency-Replay: true` 响应头。**不再触达 handler**，因此 `MultiDiGraph.add_edge` 不会重复加边。
   - 同 key + 不同 body → 返回 `409 Conflict`，防止 key 被滥用复盖前一次语义。
   - 不带 header → 透传，不缓存。保留对未升级客户端 / 后台脚本的向后兼容。
   - 仅缓存 2xx JSON dict 响应；4xx/5xx 不缓存（避免错误状态被永久回放）。
3. **TTL**：默认 10 分钟。覆盖典型用户交互重试窗口；服务进程重启即清空（in-flight 重试在重启场景下天然失效，无需持久化）。
4. **范围**：所有 `POST` 路径（含 `/api/snap_parts`、`/api/apply_force`、`/api/verify/save`、`/api/tools/upload_thumbnail` 等）。中间件层全局生效，新增端点零成本继承。
