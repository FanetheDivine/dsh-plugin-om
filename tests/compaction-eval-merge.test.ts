import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  type FactList,
  factsHash,
  type Judge,
} from '../.agents/skills/compaction-eval/scripts/judging.ts';
import { mergeFacts, mergeJudge } from '../.agents/skills/compaction-eval/scripts/merge.ts';

/** 建临时评估目录，写入 meta.json 并建 parts/facts。 */
function evalDir(range: [number, number] = [0, 9]): string {
  const dir = mkdtempSync(join(tmpdir(), 'ce-merge-'));
  writeFileSync(
    join(dir, 'meta.json'),
    JSON.stringify({ range, phase: 'observe', variants: 1 }),
    'utf8',
  );
  mkdirSync(join(dir, 'parts', 'facts'), { recursive: true });
  return dir;
}

const fact = (over: Record<string, unknown> = {}) => ({
  fact: '要点',
  category: 'A',
  source_indices: [1],
  check_hint: '查 index 1',
  ...over,
});

const verdict = (over: Record<string, unknown> = {}) => ({
  id: 'F01',
  verdict: '保留',
  quote: '原文',
  ...over,
});

describe('merge facts', () => {
  let dir: string;

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    dir = evalDir();
  });

  afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
  });

  test('合并三段与无关信息，统一编号并按分段定位', () => {
    const p = join(dir, 'parts', 'facts');
    writeFileSync(
      join(p, 'head.json'),
      JSON.stringify([fact({ source_indices: [0, 2] }), fact({ category: 'B' })]),
    );
    writeFileSync(
      join(p, 'mid.json'),
      JSON.stringify([fact({ category: 'C', evidence_after: 'after.md 第 3 行' })]),
    );
    writeFileSync(join(p, 'tail.json'), JSON.stringify([fact({ source_indices: [9] })]));
    writeFileSync(
      join(p, 'irrelevant.json'),
      JSON.stringify([{ fact: '无关', is_credential: true }, { fact: '噪音' }]),
    );

    mergeFacts(dir);

    const fj: FactList = JSON.parse(readFileSync(join(dir, 'facts.json'), 'utf8'));
    expect(fj.facts.map((f) => f.id)).toEqual(['F01', 'F02', 'F03', 'F04']);
    expect(fj.facts.map((f) => f.position)).toEqual(['head', 'head', 'mid', 'tail']);
    expect(fj.facts[2]?.evidence_after).toBe('after.md 第 3 行');
    expect(fj.irrelevant.map((d) => d.id)).toEqual(['D01', 'D02']);
    expect(fj.irrelevant[0]?.is_credential).toBe(true);
    expect(fj.facts.map((f) => f.source_indices[0])).toEqual([0, 1, 1, 9]);
  });

  test('同一分段拆多个文件按编号顺序拼接', () => {
    const p = join(dir, 'parts', 'facts');
    writeFileSync(join(p, 'head.json'), JSON.stringify([fact()]));
    writeFileSync(join(p, 'head-2.json'), JSON.stringify([fact({ category: 'B' })]));
    writeFileSync(join(p, 'mid.json'), JSON.stringify([]));
    writeFileSync(join(p, 'tail.json'), JSON.stringify([]));
    writeFileSync(join(p, 'irrelevant.json'), JSON.stringify([]));

    mergeFacts(dir);

    const fj: FactList = JSON.parse(readFileSync(join(dir, 'facts.json'), 'utf8'));
    expect(fj.facts.map((f) => f.category)).toEqual(['A', 'B']);
  });

  test('校验失败列出全部问题、不写文件', () => {
    const p = join(dir, 'parts', 'facts');
    writeFileSync(
      join(p, 'head.json'),
      JSON.stringify([fact({ source_indices: [99] }), fact({ category: 'Z' })]),
    );
    writeFileSync(join(p, 'mid.json'), JSON.stringify([{ fact: '缺 hint', source_indices: [2] }]));
    writeFileSync(join(p, 'tail.json'), JSON.stringify([]));
    writeFileSync(join(p, 'irrelevant.json'), JSON.stringify([]));

    mergeFacts(dir);

    expect(existsSync(join(dir, 'facts.json'))).toBe(false);
    expect(process.exitCode).toBe(1);
    const errs = vi.mocked(console.error).mock.calls.map((c) => String(c[0]));
    expect(errs.join('\n')).toMatch(/source_indices 超出区间 \[0\.\.9\]：99/);
    expect(errs.join('\n')).toMatch(/category 应为 A\/B\/C，实际 Z/);
    expect(errs.join('\n')).toMatch(/缺少 check_hint/);
  });

  test('缺分段文件报错', () => {
    const p = join(dir, 'parts', 'facts');
    writeFileSync(join(p, 'head.json'), JSON.stringify([fact()]));
    writeFileSync(join(p, 'irrelevant.json'), JSON.stringify([]));

    mergeFacts(dir);

    expect(existsSync(join(dir, 'facts.json'))).toBe(false);
    const errs = vi
      .mocked(console.error)
      .mock.calls.map((c) => String(c[0]))
      .join('\n');
    expect(errs).toMatch(/缺少分段文件 mid\.json/);
    expect(errs).toMatch(/缺少分段文件 tail\.json/);
  });

  test('条数偏离建议值仅告警', () => {
    const p = join(dir, 'parts', 'facts');
    writeFileSync(join(p, 'head.json'), JSON.stringify([fact()]));
    writeFileSync(join(p, 'mid.json'), JSON.stringify([]));
    writeFileSync(join(p, 'tail.json'), JSON.stringify([]));
    writeFileSync(join(p, 'irrelevant.json'), JSON.stringify([]));

    mergeFacts(dir);

    expect(process.exitCode).toBe(0);
    expect(existsSync(join(dir, 'facts.json'))).toBe(true);
    const warns = vi
      .mocked(console.warn)
      .mock.calls.map((c) => String(c[0]))
      .join('\n');
    expect(warns).toMatch(/关键事实 1 条，建议 20–35 条/);
    expect(warns).toMatch(/无关信息 0 条，建议至少 5 条/);
  });
});

describe('merge judge', () => {
  let dir: string;
  let fj: FactList;

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    dir = evalDir();
    fj = {
      facts: [
        {
          id: 'F01',
          fact: 'a',
          category: 'A',
          position: 'head',
          source_indices: [1],
          check_hint: 'h',
        },
        {
          id: 'F02',
          fact: 'b',
          category: 'B',
          position: 'head',
          source_indices: [2],
          check_hint: 'h',
        },
        {
          id: 'F03',
          fact: 'c',
          category: 'C',
          position: 'tail',
          source_indices: [8],
          check_hint: 'h',
        },
      ],
      irrelevant: [{ id: 'D01', fact: 'd', is_credential: false }],
    };
    writeFileSync(join(dir, 'facts.json'), JSON.stringify(fj), 'utf8');
  });

  afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
  });

  const parts = () => join(dir, 'parts', 'judge-V1-1');

  test('合并四段为 judge 文件并写入 facts_sha', () => {
    mkdirSync(parts(), { recursive: true });
    writeFileSync(
      join(parts(), 'head.json'),
      JSON.stringify([verdict(), verdict({ id: 'F02', verdict: '部分' })]),
    );
    writeFileSync(join(parts(), 'tail.json'), JSON.stringify([verdict({ id: 'F03' })]));
    writeFileSync(
      join(parts(), 'rest.json'),
      JSON.stringify({
        irrelevant: [{ id: 'D01', verdict: '已省略' }],
        unsupported_claims: [{ quote: '任务完成', reason: '无原文依据' }],
        extra_irrelevant: [{ content: '重复寒暄', chars_estimate: 40 }],
        overall_comment: '总体可信',
      }),
    );

    mergeJudge(dir, 'V1', '1');

    const judge: Judge = JSON.parse(readFileSync(join(dir, 'judge-V1-1.json'), 'utf8'));
    expect(judge.facts.map((f) => f.id)).toEqual(['F01', 'F02', 'F03']);
    expect(judge.facts[1]?.verdict).toBe('部分');
    expect(judge.irrelevant?.[0]?.id).toBe('D01');
    expect(judge.unsupported_claims?.[0]?.quote).toBe('任务完成');
    expect(judge.extra_irrelevant?.[0]?.content).toBe('重复寒暄');
    expect(judge.overall_comment).toBe('总体可信');
    expect(judge.facts_sha).toBe(factsHash(fj));
  });

  test('漏判事实与错放分段都报错且不写文件', () => {
    mkdirSync(parts(), { recursive: true });
    // F03 属 tail，被错写在 head.json；F02 整条缺失；rest 缺失。
    writeFileSync(join(parts(), 'head.json'), JSON.stringify([verdict(), verdict({ id: 'F03' })]));
    writeFileSync(join(parts(), 'tail.json'), JSON.stringify([]));

    mergeJudge(dir, 'V1', '1');

    expect(existsSync(join(dir, 'judge-V1-1.json'))).toBe(false);
    expect(process.exitCode).toBe(1);
    const errs = vi
      .mocked(console.error)
      .mock.calls.map((c) => String(c[0]))
      .join('\n');
    expect(errs).toMatch(/事实 F03 属于 tail，被写在 head\.json/);
    expect(errs).toMatch(/未覆盖事实 F02/);
    expect(errs).toMatch(/缺少分段文件 rest\.json/);
  });

  test('判定词非法报错', () => {
    mkdirSync(parts(), { recursive: true });
    writeFileSync(
      join(parts(), 'head.json'),
      JSON.stringify([verdict({ verdict: '保存' }), verdict({ id: 'F02' })]),
    );
    writeFileSync(join(parts(), 'tail.json'), JSON.stringify([verdict({ id: 'F03' })]));
    writeFileSync(join(parts(), 'rest.json'), JSON.stringify({ irrelevant: [] }));

    mergeJudge(dir, 'V1', '1');

    expect(existsSync(join(dir, 'judge-V1-1.json'))).toBe(false);
    expect(process.exitCode).toBe(1);
    const errs = vi
      .mocked(console.error)
      .mock.calls.map((c) => String(c[0]))
      .join('\n');
    expect(errs).toMatch(/事实 F01 判定词非法：保存/);
  });

  test('缺 facts.json 时抛错不写文件', () => {
    const noFacts = evalDir();
    expect(() => mergeJudge(noFacts, 'V2', '1')).toThrow();
    expect(readdirSync(noFacts).includes('judge-V2-1.json')).toBe(false);
  });
});
