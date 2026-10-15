/**
 * 汇总盲评结果与日志指标，输出 scores.json 与 scores.md。
 *
 * 用法：node aggregate.ts <评估目录>
 * 输入：meta.json、_blind_key.json、facts.json、judge-V*.json、V*.xml、source.xml。
 * 维度：关键信息保留 50%、尾部详略 20%、无关信息压缩 15%、总时间 15%。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BlindEntry, Buckets, Position } from './prepare.ts';

/** 事实分类。 */
type Category = 'A' | 'B' | 'C';

/** facts.json 中的关键事实。 */
interface Fact {
  id: string;
  fact: string;
  category: Category;
  position: Position;
}

/** facts.json 中的无关信息。 */
interface Irrelevant {
  id: string;
  is_credential?: boolean;
}

/** judge-V*.json 内容。 */
interface Judge {
  facts: { id: string; verdict: string }[];
  irrelevant: { id: string; verdict: string }[];
  unsupported_claims?: object[];
  tail_detail?: { score?: number };
}

/** meta.json 内容。 */
interface Meta {
  session: string;
  range: [number, number];
  buckets: Buckets;
}

/** 单个变体的评分。 */
export interface VariantScore {
  model: string;
  retention: number;
  by_category: Record<Category, number>;
  by_position: Record<Position, number>;
  verdict_counts: Record<string, number>;
  A_failed: string[];
  irrelevant: number;
  credential_leak: boolean;
  unsupported_claims: number;
  chars: Record<Position, number>;
  tail_vs_head: number | null;
  judge_tail: number;
  tail: number;
  time: number;
  composite: number;
  wall_sec: number;
  requests: number;
  tokens_in: number;
  tokens_out: number;
}

/** 事实分类权重。 */
const W: Record<Category, number> = { A: 3, B: 2, C: 1 };
/** 事实判定得分。 */
const VERDICT: Record<string, number> = { 保留: 1, 部分: 0.5, 丢失: 0, 歪曲: -1 };
/** 无关信息判定得分。 */
const D_VERDICT: Record<string, number> = { 已省略: 1, 已概括: 0.7, 详细保留: 0 };
/** 综合分维度权重。 */
const WEIGHTS = { retention: 0.5, tail: 0.2, irrelevant: 0.15, time: 0.15 } as const;
/** 位置分段。 */
const POS: Position[] = ['head', 'mid', 'tail'];
/** 事实分类。 */
const CATS: Category[] = ['A', 'B', 'C'];

/** 保留一位小数。 */
const r1 = (x: number) => Math.round(x * 10) / 10;

/** index 所在分段。 */
function bucketOf(i: number, bk: Buckets): Position {
  return POS.find((p) => bk[p][0] <= i && i <= bk[p][1]) ?? 'tail';
}

/** assistant 条目的 [起, 止, CDATA 字符数]；toolcall 条目计 args 与 result。 */
export function entrySpans(xml: string): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (const m of xml.matchAll(/<assistant([^>]*)>([\s\S]*?)<\/assistant>/g)) {
    const attrs = m[1] ?? '';
    const body = m[2] ?? '';
    const se = /start="(\d+)" end="(\d+)"/.exec(attrs);
    const idx = /index="(\d+)"/.exec(attrs);
    const lo = Number(se?.[1] ?? idx?.[1]);
    const hi = Number(se?.[2] ?? idx?.[1]);
    const chars = [...body.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)].reduce(
      (s, c) => s + (c[1]?.length ?? 0),
      0,
    );
    out.push([lo, hi, chars]);
  }
  return out;
}

/** 按分段统计字符数，区间条目按覆盖的 assistant index 均摊。 */
export function positionChars(
  xml: string,
  bk: Buckets,
  assistantIdx: Set<number>,
): Record<Position, number> {
  const acc: Record<Position, number> = { head: 0, mid: 0, tail: 0 };
  for (const [lo, hi, chars] of entrySpans(xml)) {
    const covered = Array.from({ length: hi - lo + 1 }, (_, k) => lo + k).filter((i) =>
      assistantIdx.has(i),
    );
    const idx = covered.length ? covered : [lo];
    for (const i of idx) acc[bucketOf(i, bk)] += chars / idx.length;
  }
  return { head: Math.round(acc.head), mid: Math.round(acc.mid), tail: Math.round(acc.tail) };
}

/** 加权得分率（%）。 */
export function weightedRatio(items: [Category, number][]): number {
  const den = items.reduce((s, [c]) => s + W[c], 0);
  return den ? r1((items.reduce((s, [c, v]) => s + W[c] * v, 0) / den) * 100) : 0;
}

/** 读取评估目录下的 JSON 文件。 */
function readJson<T>(dir: string, name: string): T {
  return JSON.parse(readFileSync(join(dir, name), 'utf8')) as T;
}

/** 对全部变体评分。 */
export function scoreAll(dir: string): {
  source_chars: Record<Position, number>;
  variants: Record<string, VariantScore>;
} {
  const text = (name: string) => readFileSync(join(dir, name), 'utf8');
  const meta = readJson<Meta>(dir, 'meta.json');
  const key = readJson<Record<string, BlindEntry>>(dir, '_blind_key.json');
  const fj = readJson<{ facts: Fact[]; irrelevant: Irrelevant[] }>(dir, 'facts.json');
  const bk = meta.buckets;
  const sourceXml = text('source.xml');
  const assistantIdx = new Set(entrySpans(sourceXml).map(([lo]) => lo));
  const variants: Record<string, VariantScore> = {};

  for (const [v, k] of Object.entries(key).sort(([a], [b]) => a.localeCompare(b))) {
    const j = readJson<Judge>(dir, `judge-${v}.json`);
    const fv = new Map(j.facts.map((x) => [x.id, x.verdict]));
    const dv = new Map(j.irrelevant.map((x) => [x.id, x.verdict]));
    const verdictOf = (id: string) => fv.get(id) ?? '丢失';
    const sc = (fs: Fact[]) =>
      weightedRatio(fs.map((f) => [f.category, VERDICT[verdictOf(f.id)] ?? 0]));
    const chars = positionChars(text(`${v}.xml`), bk, assistantIdx);
    const judgeTail = j.tail_detail?.score ?? 0;
    const byPos = Object.fromEntries(
      POS.map((p) => [p, sc(fj.facts.filter((f) => f.position === p))]),
    ) as Record<Position, number>;
    const irrelevant = fj.irrelevant.length
      ? r1(
          (fj.irrelevant.reduce((s, x) => s + (D_VERDICT[dv.get(x.id) ?? '详细保留'] ?? 0), 0) /
            fj.irrelevant.length) *
            100,
        )
      : 100;
    variants[v] = {
      model: `${k.model} ${k.effort}${k.recompress ? '' : '（原始）'}`,
      retention: sc(fj.facts),
      by_category: Object.fromEntries(
        CATS.map((c) => [c, sc(fj.facts.filter((f) => f.category === c))]),
      ) as Record<Category, number>,
      by_position: byPos,
      verdict_counts: Object.fromEntries(
        Object.keys(VERDICT).map((x) => [x, fj.facts.filter((f) => verdictOf(f.id) === x).length]),
      ),
      A_failed: fj.facts
        .filter((f) => f.category === 'A' && ['丢失', '歪曲'].includes(verdictOf(f.id)))
        .map((f) => f.id),
      irrelevant,
      credential_leak: fj.irrelevant.some((x) => x.is_credential && dv.get(x.id) === '详细保留'),
      unsupported_claims: j.unsupported_claims?.length ?? 0,
      chars,
      tail_vs_head: chars.head ? Math.round((chars.tail / chars.head) * 100) / 100 : null,
      judge_tail: judgeTail,
      tail: r1(((judgeTail / 5) * 100 + byPos.tail) / 2),
      time: 0,
      composite: 0,
      wall_sec: k.wall_sec,
      requests: k.requests,
      tokens_in: k.tokens_in,
      tokens_out: k.tokens_out,
    };
  }
  const tmin = Math.min(...Object.values(variants).map((r) => r.wall_sec));
  for (const r of Object.values(variants)) {
    r.time = r.wall_sec ? r1((tmin / r.wall_sec) * 100) : 0;
    r.composite = r1(
      WEIGHTS.retention * r.retention +
        WEIGHTS.tail * r.tail +
        WEIGHTS.irrelevant * r.irrelevant +
        WEIGHTS.time * r.time,
    );
  }
  return { source_chars: positionChars(sourceXml, bk, assistantIdx), variants };
}

/** 渲染 scores.md。 */
function renderMarkdown(dir: string, variants: Record<string, VariantScore>): string {
  const meta = readJson<Meta>(dir, 'meta.json');
  const facts = readJson<{ facts: Fact[] }>(dir, 'facts.json').facts;
  const all = Object.entries(variants);
  const lines = [
    `# 压缩质量评分：${meta.session} [${meta.range[0]}..${meta.range[1]}]`,
    '',
    '| 变体 | 模型 | 综合 | 保留 | A 类 | 尾部 | 无关压缩 | 耗时 | 输入/输出 token | 尾/头字符 |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...all
      .sort(([, a], [, b]) => b.composite - a.composite)
      .map(
        ([v, r]) =>
          `| ${v} | ${r.model} | ${r.composite} | ${r.retention} | ${r.by_category.A} | ${r.tail} | ${r.irrelevant} | ${r.wall_sec}s | ${r.tokens_in} / ${r.tokens_out} | ${r.tail_vs_head} |`,
      ),
  ];
  const common = facts.filter(
    (f) =>
      f.category === 'A' &&
      all.filter(([, r]) => r.A_failed.includes(f.id)).length * 2 >= all.length,
  );
  const leaks = all.filter(([, r]) => r.credential_leak).map(([v]) => `- ${v}`);
  lines.push('', '## 过半变体失败的 A 类事实，需回 source.xml 核实', '');
  lines.push(...(common.length ? common.map((f) => `- ${f.id} ${f.fact}`) : ['- 无']));
  lines.push('', '## 凭据泄漏', '', ...(leaks.length ? leaks : ['- 无']));
  return `${lines.join('\n')}\n`;
}

/** 命令行入口。 */
function main(): void {
  const dir = process.argv[2] ?? '.';
  const result = scoreAll(dir);
  writeFileSync(join(dir, 'scores.json'), JSON.stringify(result, null, 1), 'utf8');
  const md = renderMarkdown(dir, result.variants);
  writeFileSync(join(dir, 'scores.md'), md, 'utf8');
  console.log(md);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
