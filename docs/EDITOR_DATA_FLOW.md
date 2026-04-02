# LDraw Web CAD 数据流链路设计 (Data Flow)

本篇解构在执行一次带撤销能力的克隆操作时，系统底层的数据运转环及影响面。

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant Keyboard as Keyboard Binder (useKeyboardShortcuts.ts)
    participant Store as State Manager (store.ts / Zustand)
    participant Clipboard as Global Clipboard (RAM Array)
    participant UUID as crypto.randomUUID (Data Gen)
    participant History as History Stack (historyStack.ts)
    participant Renderer as Three.js / React-Fiber

    note right of User: 按下 Cmd+D（克隆连通组）
    User->>Keyboard: KeyDown ('d', Meta: true)
    
    Keyboard-->>Keyboard: 校验 focus：判定输入框是否激活（避光防守）
    Keyboard->>Store: duplicateSelected() 调用
    
    rect rgb(240, 248, 255)
        note right of Store: Phase 1: 序列化取帧
        Store->>Store: 获取当前 Selection.allConnectedIds
        Store->>Clipboard: Object => JSON.parse(JSON.stringify(Selection)) 深拷贝
        Clipboard-->>Store: 写出只读状态矩阵数据集
    end

    rect rgb(255, 240, 245)
        note right of Store: Phase 2: 反向映射派生
        Store->>Clipboard: 提取刚被刻录进的帧片段
        loop 对选中的所有旧零件
            Store->>UUID: 取解构后 8 位混淆乱码
            UUID-->>Store: 返回新唯一主键 PID_NEW
            Store->>Store: Vector3 叠加 [+0.05, +0.05, +0.05] 微平移
        end
    end

    rect rgb(245, 255, 245)
        note right of Store: Phase 3: 命令落盘及快照下发
        Store->>History: 生成 TopologySnapshot (内含 addedParts=PID_NEW 等)
        History->>History: 生成 PASTE 专署 ActionCommand 派生存入 (Stack.push)
        Store->>Store: Zustand set() 挂载 state.parts[PID_NEW]
        Store->>Store: 变更 selection 将视口焦点转移至新增体
    end

    Store->>Renderer: React 状态订阅引发 React-Fiber 钩子唤醒
    Renderer-->>User: 视口重绘，看到新积木并自动闪烁吸附特征点
```

## 撤销状态反向补偿流 (Undo Data Reversion)

当用户在上述结束后点击撤回（`Cmd+Z`）：

1.  **总线引流**：`Keyboard` 总线转手进入 `Store.undo()`
2.  **出栈决策**：`HistoryStack` 从顶端弹出上文打包的 `PASTE` TopologyCommand
3.  **负熵回归**：命令的 `revertFn` 拿到其私有快照，并指派 Store 从大盘中切除并 `delete np[PID_NEW]`
4.  **下沉未来**：该 Command 自我压入 `future` 并清零 selection
5.  **图元蒸发**：引擎由于无零件供应，新零件自动从 `Scene.jsx` 的渲染树中下线消失。
