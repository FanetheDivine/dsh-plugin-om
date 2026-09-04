// embedding.ts 单元测试：cosineSimilarity 余弦相似度（归一化、正交与零向量边界）。
import { describe, expect, it } from 'vitest';

import { cosineSimilarity } from '../src/embedding.ts';

describe('cosine 相似度 cosineSimilarity', () => {
  it('相同向量 = 1，正交 = 0，零向量 = 0', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity(new Float32Array(4), new Float32Array(4))).toBe(0);
  });

  it('未归一化向量自动归一化（比例不变）', () => {
    expect(cosineSimilarity([2, 0], [1, 0])).toBeCloseTo(1, 10);
    expect(cosineSimilarity([3, 4], [0, 1])).toBeCloseTo(0.8, 10);
  });
});
