import { describe, it, expect } from 'vitest';
import { isConnectorCategory } from '../utils/partCategory';

describe('isConnectorCategory', () => {
  it('销/轴/连接器 → true', () => {
    expect(isConnectorCategory('Pin')).toBe(true);
    expect(isConnectorCategory('Axle')).toBe(true);
    expect(isConnectorCategory('Connector')).toBe(true);
  });
  it('板/梁/砖/其它 → false', () => {
    expect(isConnectorCategory('Plate')).toBe(false);
    expect(isConnectorCategory('Beam')).toBe(false);
    expect(isConnectorCategory('Brick')).toBe(false);
    expect(isConnectorCategory('Other')).toBe(false);
  });
  it('空 / undefined → false', () => {
    expect(isConnectorCategory(undefined)).toBe(false);
    expect(isConnectorCategory(null)).toBe(false);
    expect(isConnectorCategory('')).toBe(false);
  });
});
