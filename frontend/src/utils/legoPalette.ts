/**
 * legoPalette.ts
 * ==============
 * 共享的常用 LDraw 颜色板。原先内联在 PartPreviewOverlay；抽出来给「已放置零件
 * 改色」(RecolorPalette) 复用，单一真相源避免两处色卡漂移。
 */

export interface LegoColor {
  /** LDraw 颜色码 */
  code: number;
  /** 显示用 hex */
  hex: string;
  /** 人类可读名 */
  name: string;
}

export const LEGO_PALETTE: ReadonlyArray<LegoColor> = [
  { code: 0,   hex: '#212121', name: 'Black' },
  { code: 1,   hex: '#1565C0', name: 'Blue' },
  { code: 2,   hex: '#388E3C', name: 'Green' },
  { code: 4,   hex: '#D32F2F', name: 'Red' },
  { code: 6,   hex: '#4E342E', name: 'Brown' },
  { code: 7,   hex: '#9E9E9E', name: 'Light Gray' },
  { code: 8,   hex: '#455A64', name: 'Dark Gray' },
  { code: 14,  hex: '#FDD835', name: 'Yellow' },
  { code: 15,  hex: '#FFFFFF', name: 'White' },
  { code: 25,  hex: '#FF8F00', name: 'Orange' },
  { code: 70,  hex: '#6D4C41', name: 'Reddish Brown' },
  { code: 71,  hex: '#B0BEC5', name: 'Lt Bluish Gray' },
  { code: 72,  hex: '#546E7A', name: 'Dk Bluish Gray' },
] as const;
