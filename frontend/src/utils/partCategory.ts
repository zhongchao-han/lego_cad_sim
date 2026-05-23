/**
 * partCategory.ts
 * ===============
 * 零件 category 语义判定。category 由 backend/category.py 启发式注入
 * （'Pin' / 'Axle' / 'Connector' / 'Beam' / 'Plate' / ...）。
 */

/** 连接件桶：销 / 轴 / 连接器 —— 它们的职责是「连接两个零件」，是关节而非刚体货物。 */
const CONNECTOR_CATEGORIES: ReadonlySet<string> = new Set(['Pin', 'Axle', 'Connector']);

/**
 * 是否连接件（销/轴/连接器）。翻面时用：连接件不随板刚体翻到顶上，而是留在原位
 * 继续充当两部分之间的连接（见 store._transformSelectedSubassembly keepConnectorsFixed）。
 */
export function isConnectorCategory(category?: string | null): boolean {
  return !!category && CONNECTOR_CATEGORIES.has(category);
}
