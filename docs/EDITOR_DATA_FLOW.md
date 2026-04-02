# LDraw Web CAD 数据流链路设计 (Data Flow)

本篇解构在执行一次带撤销能力的克隆 / 粘贴操作时，系统底层的数据运转环及影响面。特别是光标跟随流（Cursor-Following）的雷达寻路机制。

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant Keyboard as Keyboard Binder
    participant Store as State Manager (Zustand)
    participant Scene as GhostPlacer (Scene.jsx)
    participant History as History Stack (historyStack.ts)
    participant Renderer as Three.js / React-Fiber

    note right of User: 按下 Cmd+D（克隆连通组）
    User->>Keyboard: KeyDown ('d', Meta: true)
    
    Keyboard-->>Keyboard: 校验 focus 避让
    Keyboard->>Store: duplicateSelected() 调用
    
    rect rgb(240, 248, 255)
        note right of Store: Phase 1: 序列化到剪贴板
        Store->>Store: 将 Selection.allConnectedIds 压入 clipboard 深拷贝
    end

    rect rgb(255, 240, 245)
        note right of Store: Phase 2: 构建幽灵负荷 (Payload)
        Store->>Store: pasteClipboard() 调用
        Store->>Store: 计算剪贴板包围盒中心 (centroid)
        Store->>Store: 重置 UUID，局部化坐标，写入 freePlacingPayload
        Store->>Store: interactionPhase = FREE_PLACING
    end

    rect rgb(255, 250, 230)
        note right of Scene: Phase 3: 帧循环雷达追踪 (Hover)
        Store->>Scene: 激活 FreePlacerGhost 组件
        loop 每帧 useFrame
            Scene->>Renderer: Raycaster 从摄像机射向光标
            Renderer-->>Scene: 剔除幽灵自身的相交数组
            Scene->>Scene: groupRef.position.copy(hits[0].point)
        end
    end

    User->>Scene: 单击鼠标左键 (确认锚点)
    
    rect rgb(245, 255, 245)
        note right of Store: Phase 4: 命令落盘及快照下发
        Scene->>Store: commitFreePlacing({ ...偏移后的绝对坐标 })
        Store->>History: 生成 TopologySnapshot (PASTE)
        History->>History: 生成 ActionCommand 存入 (Stack.push)
        Store->>Store: 挂载 state.parts，清空 payload，恢复 IDLE 态
    end

    Store->>Renderer: 数据树变更，触发实体化重绘
```

## 撤销状态反向补偿流 (Undo Data Reversion)

当用户在上述结束后点击撤回（`Cmd+Z`）：

1.  **总线引流**：`Keyboard` 总线转手进入 `Store.undo()`
2.  **出栈决策**：`HistoryStack` 从顶端弹出上文打包的 `PASTE` TopologyCommand
3.  **负熵回归**：命令的 `revertFn` 拿到其私有快照，并指派 Store 从大盘中切除新增的 `UUID`
4.  **图元蒸发**：引擎由于无零件供应，新实体积木自动从 `Scene.jsx` 下线消失。
