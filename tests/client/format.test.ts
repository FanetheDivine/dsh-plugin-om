// 压缩卡片统计行数字单位化：k / w（万）/ M。
import { describe, expect, it } from 'vitest';
import { formatCompactCount } from '../../src/client/format.ts';

describe('formatCompactCount', () => {
  it('小于 1000 原样输出', () => {
    expect(formatCompactCount(0)).toBe('0');
    expect(formatCompactCount(456)).toBe('456');
    expect(formatCompactCount(999)).toBe('999');
  });

  it('千位用 k：保留 1 位小数并去掉末尾 .0', () => {
    expect(formatCompactCount(1000)).toBe('1k');
    expect(formatCompactCount(8642)).toBe('8.6k');
    expect(formatCompactCount(1234)).toBe('1.2k');
    expect(formatCompactCount(9999)).toBe('10k');
  });

  it('万位用 w', () => {
    expect(formatCompactCount(10000)).toBe('1w');
    expect(formatCompactCount(34567)).toBe('3.5w');
    expect(formatCompactCount(123456)).toBe('12.3w');
    expect(formatCompactCount(999999)).toBe('100w');
  });

  it('百万以上用 M', () => {
    expect(formatCompactCount(1_000_000)).toBe('1M');
    expect(formatCompactCount(1_234_567)).toBe('1.2M');
    expect(formatCompactCount(12_345_678)).toBe('12.3M');
  });
});
