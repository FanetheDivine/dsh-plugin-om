/**
 * 汇总盲评结果与日志指标，输出 scores.json 与 scores.md。
 *
 * 用法：node aggregate.ts <评估目录> [--reference original|provider/model[:effort]]...
 * 输入：meta.json、_blind_key.json、facts.json、judge-<V>-1.json、judge-<V>-2.json、V*.xml、source.xml。
 * 维度：关键信息保留 70%、无关信息压缩 20%、精简度 5%、模型耗时 5%。
 * --reference 可重复，选中的候选作为参考：照常算保留率与无关信息压缩，
 * 精简度与耗时按参与候选的最短产物、最快耗时折算并封顶 100，不参与排名与汇总。
 * 诊断输出不计分：分段保留率、分段压缩率、后续依据保留率、缓存 token、评审分歧。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Category,
  D_VERDICT,
  type Fact,
  type FactList,
  factsHash,
  type Judge,
  judgeProblems,
  VERDICT,
  W,
} from './judging.ts';
import type { BlindEntry, Buckets, Position } from './prepare.ts';

/** meta.json 内容。 */
interface Meta {
  session: string;
  phase?: string;
  range: [number, number];
  buckets: Buckets;
}

/** 单个变体的评分；reference 为真的候选不参与排名与汇总。 */
export interface VariantScore {
  model: string;
  reference: boolean;
  retention: number;
  /** 仅计 facts 中 evidence_after 非空事实的保留率；无此类事实为 null。 */
  retention_after: number | null;
  after_facts: number;
  by_category: Record<Category, number | null>;
  by_position: Record<Position, number | null>;
  A_failed: string[];
  irrelevant: number;
  credential_leak: boolean;
  unsupported_claims: number;
  extra_irrelevant: number;
  chars: Record<Position, number>;
  product_chars: number;
  compression: Record<Position, number | null>;
  conciseness: number;
  time: number;
  composite: number;
  model_sec: number;
  wall_sec: number;
  requests: number;
  tokens_in: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  tokens_out: number;
}

/** 两名评审判定不一致的条目。 */
export interface Disagreement {
  variant: string;
  id: string;
  verdicts: [string, string];
}

/** 按模型汇总的综合分。 */
export interface ModelSummary {
  model: string;
  n: number;
  mean: number;
  std: number;
}

/** 综合分维度权重。 */
const WEIGHTS = { retention: 0.7, conciseness: 0.05, irrelevant: 0.2, time: 0.05 } as const;
/** 每条无依据断言扣除的分子分。 */
const CLAIM_PENALTY = 2;
/** 每个变体的评审数量。 */
const JUDGE_COUNT = 2;
/** 位置分段。 */
const POS: Position[] = ['head', 'mid', 'tail'];
/** 事实分类。 */
const CATS: Category[] = ['A', 'B', 'C'];

/** 保留一位小数。 */
const r1 = (x: number) => Math.round(x * 10) / 10;

/** 保留两位小数。 */
const r2 = (x: number) => Math.round(x * 100) / 100;

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

/** 读取并校验单个评审文件：必须存在、全覆盖、判定词合法、与当前 facts.json 同版。 */
export function loadJudge(dir: string, name: string, fj: FactList): Judge {
  if (!existsSync(join(dir, name))) throw new Error(`缺少评审文件 ${name}`);
  const j = readJson<Judge>(dir, name);
  const problems = judgeProblems(j, fj, name);
  const sha = factsHash(fj);
  if (j.facts_sha !== sha)
    problems.push(`${name} 基于旧版 facts.json（facts_sha 不符），修正清单后需重新评审`);
  if (problems.length) throw new Error(problems.join('\n'));
  return j;
}

/** 解析参考选择器，返回命中的变体号：original 选原始压缩，provider/model[:effort] 选模型。 */
export function referenceVariants(key: Record<string, BlindEntry>, sel: string): string[] {
  const entries = Object.entries(key);
  if (sel === 'original') return entries.filter(([, k]) => !k.recompress).map(([v]) => v);
  const cut = sel.lastIndexOf(':');
  const model = cut >= 0 ? sel.slice(0, cut) : sel;
  const effort = cut >= 0 ? sel.slice(cut + 1) : undefined;
  return entries
    .filter(([, k]) => k.model === model && (effort === undefined || k.effort === effort))
    .map(([v]) => v);
}

/** 综合分均值与样本标准差；变体不足 2 个的模型不输出。 */
export function modelSummary(variants: Record<string, VariantScore>): ModelSummary[] {
  const groups = new Map<string, number[]>();
  for (const r of Object.values(variants)) {
    const g = groups.get(r.model) ?? [];
    g.push(r.composite);
    groups.set(r.model, g);
  }
  const out: ModelSummary[] = [];
  for (const [model, xs] of groups) {
    if (xs.length < 2) continue;
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    const va = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1);
    out.push({ model, n: xs.length, mean: r1(mean), std: r1(Math.sqrt(va)) });
  }
  return out.sort((a, b) => b.mean - a.mean);
}

/** 对全部变体评分；referenceSels 指定的候选作为参考，不参与排名与汇总。 */
export function scoreAll(
  dir: string,
  referenceSels: string[] = [],
): {
  source_chars: Record<Position, number>;
  variants: Record<string, VariantScore>;
  disagreements: Disagreement[];
} {
  const text = (name: string) => readFileSync(join(dir, name), 'utf8');
  const meta = readJson<Meta>(dir, 'meta.json');
  const key = readJson<Record<string, BlindEntry>>(dir, '_blind_key.json');
  const fj = readJson<FactList>(dir, 'facts.json');
  const bk = meta.buckets;
  const sourceXml = text('source.xml');
  const assistantIdx = new Set(entrySpans(sourceXml).map(([lo]) => lo));
  const source_chars = positionChars(sourceXml, bk, assistantIdx);
  const variants: Record<string, VariantScore> = {};
  const disagreements: Disagreement[] = [];

  const refSet = new Set<string>();
  for (const sel of referenceSels) {
    const hit = referenceVariants(key, sel);
    if (!hit.length) throw new Error(`参考选择器 ${sel} 未匹配任何候选`);
    for (const v of hit) refSet.add(v);
  }
  if (refSet.size && refSet.size === Object.keys(key).length)
    throw new Error('全部候选都被设为参考，没有参与排名的候选');

  for (const [v, k] of Object.entries(key).sort(([a], [b]) => a.localeCompare(b))) {
    const js = Array.from({ length: JUDGE_COUNT }, (_, i) =>
      loadJudge(dir, `judge-${v}-${i + 1}.json`, fj),
    );
    const verdicts = (j: Judge) => new Map(j.facts.map((x) => [x.id, x.verdict]));
    const dverdicts = (j: Judge) => new Map(j.irrelevant.map((x) => [x.id, x.verdict]));
    const vm = js.map(verdicts);
    const dm = js.map(dverdicts);

    /** 单条事实两名评审的平均判定值；分歧只记录一次。 */
    const vals = new Map<string, number>();
    for (const f of fj.facts) {
      const vs = vm.map((m) => m.get(f.id) ?? '丢失');
      if (vs[0] !== vs[1])
        disagreements.push({ variant: v, id: f.id, verdicts: [vs[0] ?? '', vs[1] ?? ''] });
      vals.set(f.id, vs.reduce((s, x) => s + (VERDICT[x] ?? 0), 0) / vs.length);
    }
    const factValue = (id: string): number => vals.get(id) ?? 0;
    /** 分段或分类得分为空时记 null，区别于全部丢失的 0。 */
    const sc = (fs: Fact[]): number | null =>
      fs.length ? weightedRatio(fs.map((f) => [f.category, factValue(f.id)])) : null;
    const chars = positionChars(text(`${v}.xml`), bk, assistantIdx);
    const unsupported = js.reduce((s, j) => s + (j.unsupported_claims?.length ?? 0), 0) / js.length;
    const extra = js.reduce((s, j) => s + (j.extra_irrelevant?.length ?? 0), 0) / js.length;
    const den = fj.facts.reduce((s, f) => s + W[f.category], 0);
    const num =
      fj.facts.reduce((s, f) => s + W[f.category] * factValue(f.id), 0) -
      CLAIM_PENALTY * unsupported;
    const irrelevant = fj.irrelevant.length
      ? r1(
          (fj.irrelevant.reduce(
            (s, x) =>
              s +
              dm.reduce((t, m) => t + (D_VERDICT[m.get(x.id) ?? '详细保留'] ?? 0), 0) / dm.length,
            0,
          ) /
            fj.irrelevant.length) *
            100,
        )
      : 100;
    const after = fj.facts.filter((f) => (f.evidence_after ?? '').trim() !== '');
    variants[v] = {
      model: `${k.model} ${k.effort}${k.recompress ? '' : '（原始）'}`,
      reference: refSet.has(v),
      retention: den ? r1((num / den) * 100) : 0,
      retention_after: after.length
        ? weightedRatio(after.map((f) => [f.category, factValue(f.id)]))
        : null,
      after_facts: after.length,
      by_category: Object.fromEntries(
        CATS.map((c) => [c, sc(fj.facts.filter((f) => f.category === c))]),
      ) as Record<Category, number | null>,
      by_position: Object.fromEntries(
        POS.map((p) => [p, sc(fj.facts.filter((f) => f.position === p))]),
      ) as Record<Position, number | null>,
      A_failed: fj.facts
        .filter((f) => f.category === 'A' && factValue(f.id) < 0.5)
        .map((f) => f.id),
      irrelevant,
      credential_leak: fj.irrelevant.some(
        (x) => x.is_credential && dm.some((m) => m.get(x.id) === '详细保留'),
      ),
      unsupported_claims: r1(unsupported),
      extra_irrelevant: r1(extra),
      chars,
      product_chars: chars.head + chars.mid + chars.tail,
      compression: Object.fromEntries(
        POS.map((p) => [p, source_chars[p] ? r2(chars[p] / source_chars[p]) : null]),
      ) as Record<Position, number | null>,
      conciseness: 0,
      time: 0,
      composite: 0,
      model_sec: k.model_sec,
      wall_sec: k.wall_sec,
      requests: k.requests,
      tokens_in: k.tokens_in,
      tokens_cache_read: k.tokens_cache_read,
      tokens_cache_write: k.tokens_cache_write,
      tokens_out: k.tokens_out,
    };
  }

  /** 参与排名的候选：精简度与耗时的基准只取自这些候选。 */
  const pool = Object.values(variants).filter((r) => !r.reference);
  const pmin = Math.min(...pool.map((r) => r.product_chars));
  const tmin = Math.min(...pool.map((r) => r.model_sec));
  for (const r of Object.values(variants)) {
    r.conciseness = r.product_chars ? Math.min(100, r1((pmin / r.product_chars) * 100)) : 0;
    r.time = r.model_sec ? Math.min(100, r1((tmin / r.model_sec) * 100)) : 0;
    r.composite = r1(
      WEIGHTS.retention * r.retention +
        WEIGHTS.conciseness * r.conciseness +
        WEIGHTS.irrelevant * r.irrelevant +
        WEIGHTS.time * r.time,
    );
  }
  return { source_chars, variants, disagreements };
}

/** 渲染 scores.md。 */
function renderMarkdown(dir: string, result: ReturnType<typeof scoreAll>): string {
  const meta = readJson<Meta>(dir, 'meta.json');
  const facts = readJson<FactList>(dir, 'facts.json').facts;
  const { variants, disagreements, source_chars } = result;
  const all = Object.entries(variants);
  const pool = all.filter(([, r]) => !r.reference);
  const refs = all.filter(([, r]) => r.reference);
  const phase = meta.phase ? ` ${meta.phase}` : '';
  const header =
    '| 变体 | 模型 | 综合 | 保留 | 精简 | 无关压缩 | 耗时 | A 类 | 无依据断言 | 模型耗时 | 输入/输出 token |';
  const rows = (xs: [string, VariantScore][]) =>
    xs
      .sort(([, a], [, b]) => b.composite - a.composite)
      .map(
        ([v, r]) =>
          `| ${v} | ${r.model} | ${r.composite} | ${r.retention} | ${r.conciseness} | ${r.irrelevant} | ${r.time} | ${r.by_category.A ?? '-'} | ${r.unsupported_claims} | ${r.model_sec}s | ${r.tokens_in} / ${r.tokens_out} |`,
      );
  const lines = [
    `# 压缩质量评分：${meta.session}${phase} [${meta.range[0]}..${meta.range[1]}]`,
    '',
    ...[header, '|---|---|---|---|---|---|---|---|---|---|---|'],
    ...rows(pool),
  ];

  if (refs.length) {
    lines.push(
      '',
      '## 参考候选，不参与排名与汇总',
      '',
      header,
      '|---|---|---|---|---|---|---|---|---|---|---|',
      ...rows(refs),
    );
  }

  const summary = modelSummary(Object.fromEntries(pool));
  if (summary.length) {
    lines.push(
      '',
      '## 按模型汇总',
      '',
      '| 模型 | 变体数 | 综合均值 | 标准差 |',
      '|---|---|---|---|',
    );
    lines.push(...summary.map((s) => `| ${s.model} | ${s.n} | ${s.mean} | ${s.std} |`));
  }

  lines.push('', '## 诊断，不计分', '');
  for (const [v, r] of all) {
    lines.push(
      `- ${v} 分段保留 head ${r.by_position.head ?? '-'} / mid ${r.by_position.mid ?? '-'} / tail ${r.by_position.tail ?? '-'}，分段压缩率 head ${r.compression.head ?? '-'} / mid ${r.compression.mid ?? '-'} / tail ${r.compression.tail ?? '-'}，后续依据保留率 ${r.retention_after ?? '-'}（${r.after_facts} 条），清单外无关内容 ${r.extra_irrelevant} 条，缓存读 ${r.tokens_cache_read} / 写 ${r.tokens_cache_write}`,
    );
  }
  lines.push(
    `- 原文分段字符 head ${source_chars.head} / mid ${source_chars.mid} / tail ${source_chars.tail}`,
  );

  if (disagreements.length) {
    lines.push('', '## 两名评审判定不一致的条目', '');
    lines.push(...disagreements.map((d) => `- ${d.variant} ${d.id}：${d.verdicts.join(' / ')}`));
  }

  const common = facts.filter(
    (f) =>
      f.category === 'A' &&
      pool.filter(([, r]) => r.A_failed.includes(f.id)).length * 2 >= pool.length,
  );
  const leaks = all.filter(([, r]) => r.credential_leak).map(([v]) => `- ${v}`);
  lines.push('', '## 过半参与候选失败的 A 类事实，需回 source.xml 核实', '');
  lines.push(...(common.length ? common.map((f) => `- ${f.id} ${f.fact}`) : ['- 无']));
  lines.push('', '## 凭据泄漏', '', ...(leaks.length ? leaks : ['- 无']));
  return `${lines.join('\n')}\n`;
}

/** 命令行入口。 */
function main(): void {
  const usage =
    '用法：node aggregate.ts <评估目录> [--reference original|provider/model[:effort]]...';
  const args = process.argv.slice(2);
  const refs: string[] = [];
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a === '--reference') {
      const v = args[i + 1];
      if (!v) {
        console.error(usage);
        process.exit(2);
      }
      refs.push(v);
      i++;
    } else if (a.startsWith('--reference=')) refs.push(a.slice('--reference='.length));
    else positional.push(a);
  }
  if (positional.length !== 1) {
    console.error(usage);
    process.exit(2);
  }
  const dir = positional[0] ?? '.';
  const result = scoreAll(dir, refs);
  writeFileSync(join(dir, 'scores.json'), JSON.stringify(result, null, 1), 'utf8');
  const md = renderMarkdown(dir, result);
  writeFileSync(join(dir, 'scores.md'), md, 'utf8');
  console.log(md);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
