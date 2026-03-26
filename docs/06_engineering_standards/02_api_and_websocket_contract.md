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
