# 技术设计文档：装配交互系统架构与接口定义

> **To Claude Code CLI:**
> Please read the following files immediately...
> - `frontend/src/store.ts` (For UI/Sim State Management)
> - `topology_manager.py` (For Gear Loop & Chain logic)

<system_integrity_definitions>
... (同前)

**深度稳定性补丁 (Deep Stability Patches)：**

1. **齿轮链相位一致性 (Gear Chain Consistency)**：
   - **逻辑**：自动咬合算法支持链式传递。若产生齿轮闭环，系统必须验证全环齿隙相位是否自洽。
   - **拦截**：若相位冲突（无法转动），即使中心距正确，也必须判定为 `BLOCKED`。

2. **干涉热图辅助 (Interference Highlighting)**：
   - **动作**：当 Snap 被拦截时，系统自动将发生几何干涉（重叠部分）的 Mesh 以红色脉冲高亮显示。
   - **目的**：为用户提供明确的故障诊断信息。

3. **仿真模式隔离 (Simulation Cold-Isolation)**：
   - **规则**：`SIMULATION` 模式仅对主画布（连通图）生效。
   - **执行**：暂存区 (Workbench) 的所有零件块在模拟期间自动隐藏，不分配物理实体，确保仿真性能与场景纯净。

4. **历史快照补齐 (Undo/Redo)**：
   - 暂存区的“彻底销毁”动作、零件的“回收”动作必须全部进入 Undo 栈。
</system_integrity_definitions>

<core_design_rules>
... (同前)
1. **先选即动**：Source 移动到 Target。
2. **目标即锚点**：落位瞬间重置 ROOT。
3. **安全销毁**：暂存区清理需二次确认。
4. **智能咬合**：支持链式自动相位对齐。
5. **轴向对齐**：强制使用 `stripAxis`。
6. **全连接约束**：禁止生成任何孤立零件块。
</core_design_rules>

<negative_constraints>
- **严禁支持柔性零件 (No Flexible Parts)**：本系统仅支持刚体物理，严禁模拟软管、绳索等非线性形变。
- **严禁在仿真模式下操作暂存区**：暂存区在物理引擎运行时必须处于锁定且不可见状态。
</negative_constraints>
