# UI 交互查询与 LLM 扩写引擎数据链路流向图 (Data Flow)

本文档旨在直观刻画乐高组件检索链路的流转，该过程重点突出了由于“模糊自然语言”参与所导致的大模型中介入（Proxy）路由。

## 实时检索流 (Real-time Search Data Flow)

```mermaid
sequenceDiagram
    participant User as 用户交互界面 (UI)
    participant Hook as usePartSearch (React)
    participant LLM as 深求深思 API (DeepSeek)
    participant Meili as MeiliSearch 高速倒排池
    participant Store as Zustand 组装栈暂存

    User->>Hook: 唤醒浮层 Cmd+K
    User->>Hook: 输入 `红色大板`
    Hook->>Hook: (本地) lodash.debounce 防抖延迟 500ms
    
    Hook->>Hook: currentCounter 递增 (防并发污染)
    Hook->>Hook: 正则识别是否含中文? (isNaturalLanguage)
    
    alt 检索字面包含汉字或结构化模糊 (如长词元)
        Hook->>LLM: 挂载 "LDraw Expert" Prompt, 传出 `红色大板` (走私钥认证)
        Note over Hook, LLM: UI 显示 "AI 视觉思考中..." 脉冲波特效
        LLM-->>Hook: 回传标准件学术名词: "Red Plate Baseplate"
    else 纯英字母数字 (精简代号或官方学名)
        Hook->>Hook: 降级走原路，直接透传 query
    end
    
    Hook->>Meili: 发送最终英文组合，携带 `status=verified`
    Note over Hook, Meili: Meili 底层同义词扩展 (Plate → Board / Baseplate)
    Meili-->>Hook: {hits: [id, part_num, name, thumbnail_url]}
    
    Hook->>User: 渲染缩略图标表列表
    
    User->>Hook: 点击期望目标件 `39369`
    Hook->>Store: 调用 `addStagedPart(39369.dat)`
    Hook->>Store: 调用 `previewPart(39369.dat)`
    Store-->>User: 主视角中央弹出三维交互窗口并入暂存库...
```

## 数据池异步清洗入库流 (ETL Offline Syncer)

离线索引库依靠后端的清洗程序将杂乱的 LDraw `.dat` 解析为文档存储形式，并附加上 `Verified` 审核属性，确保未完成骨架标记的破损件不会流向全量组装库给用户带来灾难性体验。

```mermaid
flowchart TD
    LD[本地 LDraw /parts 文件夹] --> GP[GeometryProcessor 组件]
    GP --> TM[TopologyManager (识别坐标/朝向/吸附判定)]
    TM --> DB[(/data/ldraw_port_configs.json)]
    
    DB -- Python script<br/>(sync_meili.py) --> Clean[脱敏与同义词联想策略引擎]
    Clean -- part_id 去除 /, ., 映射 Thumbnail CDN --> Meili[(MeiliSearch Index = 'parts')]

    UI[前端 UI 组件] -- 实切增量复核通过 --> Server FastApi (/api/verify/save)
    Server FastApi -- API 直推覆盖 --> Meili
```
