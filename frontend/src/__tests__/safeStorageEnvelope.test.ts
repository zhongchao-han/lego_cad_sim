import { describe, it, expect } from 'vitest';
import { checksum, wrap, unwrap, SCHEMA_VERSION } from '../persistence/safeStorage';

// 防损坏存储的完整性核心：信封 checksum 必须能识别截断/篡改的数据，
// 从而让读路径回退到另一槽，而不是把损坏数据交给 zustand 反序列化后清空草稿。
describe('safeStorage envelope integrity', () => {
  it('checksum 对相同输入稳定、对不同输入不同', () => {
    const a = '{"parts":{"x":1}}';
    expect(checksum(a)).toBe(checksum(a));
    expect(checksum(a)).not.toBe(checksum(a + ' '));
  });

  it('wrap/unwrap 往返还原原始数据', () => {
    const data = JSON.stringify({ state: { parts: { a: 1 } }, version: 0 });
    const env = wrap(data);
    expect(env.v).toBe(SCHEMA_VERSION);
    expect(typeof env.ts).toBe('number');
    expect(unwrap(env)).toBe(data);
  });

  it('checksum 不符（被篡改/截断）的信封 → unwrap 返回 null', () => {
    const env = wrap('{"hello":"world"}');
    // 模拟写到一半被截断：data 变了但 checksum 还是旧的。
    const truncated = { ...env, data: '{"hello":"wor' };
    expect(unwrap(truncated)).toBeNull();
  });

  it('结构非法（缺字段 / 非对象）→ unwrap 返回 null，不抛错', () => {
    expect(unwrap(null)).toBeNull();
    expect(unwrap(undefined)).toBeNull();
    expect(unwrap('plain string')).toBeNull();
    expect(unwrap({ data: 'x' })).toBeNull(); // 缺 checksum
    expect(unwrap({ checksum: 1 })).toBeNull(); // 缺 data
  });

  it('合法信封即使来自旧 schema 版本也按 checksum 放行（交给 merge 容错）', () => {
    const data = '{"state":{},"version":0}';
    const env = { ...wrap(data), v: 0 };
    expect(unwrap(env)).toBe(data);
  });
});
