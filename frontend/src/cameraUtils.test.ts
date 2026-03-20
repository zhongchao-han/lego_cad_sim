/**
 * cameraUtils.test.ts
 * ===================
 * 验证对焦坐标计算逻辑的准确性。
 */

import { describe, it, expect } from 'vitest';
import { calculateWorkbenchTarget, calculateAssemblyTarget, LDU } from './cameraUtils';

describe('cameraUtils', () => {

  describe('calculateWorkbenchTarget', () => {
    it('returns [0, 0, 0] when no port is provided', () => {
      expect(calculateWorkbenchTarget(null)).toEqual([0, 0, 0]);
    });

    it('multiplies port.position by LDU (0.0004) correctly', () => {
      const port = { position: [10, 20, 30] };
      const expected = [10 * LDU, 20 * LDU, 30 * LDU];
      expect(calculateWorkbenchTarget(port)).toEqual(expected);
    });

    it('returns [0, 0, 0] if port has no position property', () => {
      expect(calculateWorkbenchTarget({})).toEqual([0, 0, 0]);
    });
  });

  describe('calculateAssemblyTarget', () => {
    it('returns null when no selectedPort is provided', () => {
      expect(calculateAssemblyTarget(null)).toBeNull();
    });

    it('returns globalPos directly if available', () => {
      const selectedPort = { globalPos: [0.1, 0.2, 0.3] };
      expect(calculateAssemblyTarget(selectedPort)).toEqual([0.1, 0.2, 0.3]);
    });

    it('returns null if globalPos is missing', () => {
      expect(calculateAssemblyTarget({ id: 'some-id' })).toBeNull();
    });
  });

});
