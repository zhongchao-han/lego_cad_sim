/**
 * workbench.ts
 * =============
 * 三区空间管理 + 暂存区网格 — 纯逻辑模块，无任何框架依赖。
 *
 * 三区定义：
 *   ACTIVE_ARENA — 主画布：参与物理仿真和 URDF 导出
 *   WORKBENCH    — 暂存区：冻结物理，网格排列，不参与 URDF
 *   PREVIEW      — 预览层：只供用户选择端口，无世界坐标
 *
 * WorkbenchGrid：
 *   固定 rows × cols 槽位，每槽有固定的世界坐标（XZ 平面）。
 *   拆解产生 |S| > 1 的子装配体时，调用 findNextAvailableSlot()
 *   分配槽位并记录 occupiedBy。
 */

import { ZoneType } from './types';

// ---------------------------------------------------------------------------
// StagingSlot
// ---------------------------------------------------------------------------

export interface StagingSlot {
  readonly index: number;
  readonly gridRow: number;
  readonly gridCol: number;
  /** 槽位在世界空间中的中心位置 */
  readonly worldPosition: [number, number, number];
  /** 占用此槽位的子装配体 root ID，null = 空闲 */
  occupiedBy: string | null;
}

// ---------------------------------------------------------------------------
// StagingGrid
// ---------------------------------------------------------------------------

/**
 * 暂存区网格管理器。
 *
 * 坐标约定：
 *   槽位排列在 XZ 平面（Y = workbenchY）
 *   第 r 行第 c 列的世界位置：
 *     x = originX + c * cellSpacing
 *     z = originZ + r * cellSpacing
 */
export class StagingGrid {
  readonly slots: StagingSlot[];

  constructor(
    readonly rows: number = 5,
    readonly cols: number = 5,
    private readonly cellSpacing: number = 0.052,  // 60mm 间距
    private readonly originX: number = 0.25,       // 暂存区 X 起点
    private readonly originZ: number = -0.12,      // 暂存区 Z 起点
    private readonly workbenchY: number = 0.0,
  ) {
    this.slots = [];
    let index = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        this.slots.push({
          index,
          gridRow: r,
          gridCol: c,
          worldPosition: [
            originX + c * cellSpacing,
            workbenchY,
            originZ + r * cellSpacing,
          ],
          occupiedBy: null,
        });
        index++;
      }
    }
  }

  get capacity(): number { return this.rows * this.cols; }

  get freeCount(): number {
    return this.slots.filter(s => s.occupiedBy === null).length;
  }

  /** 返回第一个空闲槽位，或 null（暂存区已满）。*/
  findNextAvailableSlot(): StagingSlot | null {
    return this.slots.find(s => s.occupiedBy === null) ?? null;
  }

  /**
   * 分配槽位给子装配体 root ID。
   * @returns 分配的槽位，或 null（无空闲槽位）。
   */
  assign(subAssemblyRootId: string): StagingSlot | null {
    const slot = this.findNextAvailableSlot();
    if (!slot) return null;
    slot.occupiedBy = subAssemblyRootId;
    return slot;
  }

  /**
   * 释放某子装配体占用的槽位（回收或移回主画布时调用）。
   */
  releaseSlot(subAssemblyRootId: string): boolean {
    const slot = this.slots.find(s => s.occupiedBy === subAssemblyRootId);
    if (!slot) return false;
    slot.occupiedBy = null;
    return true;
  }

  /**
   * 查询某子装配体当前占用的槽位（未占用则返回 null）。
   */
  findByOccupant(subAssemblyRootId: string): StagingSlot | null {
    return this.slots.find(s => s.occupiedBy === subAssemblyRootId) ?? null;
  }

  /**
   * 清空所有槽位占用（主要用于测试重置或清空工作台）。
   */
  clearAll(): void {
    this.slots.forEach(s => s.occupiedBy = null);
  }
}
