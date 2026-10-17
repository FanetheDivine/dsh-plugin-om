/**
 * 合并 subagent 分段产出的 facts 与评审文件，并做全覆盖校验。
 *
 * 用法：
 *   node merge.ts facts <评估目录>
 *     合并 parts/facts/ 下的 head.json、head-2.json…、mid…、tail…、irrelevant…
 *     为 facts.json，按分段顺序统一编号 F01…、D01…；position 由分段文件名决定。
 *   node merge.ts judge <评估目录> <V> <N>
 *     合并 parts/judge-<V>-<N>/ 下的 head.json、mid.json、tail.json、rest.json
 *     为 judge-<V>-<N>.json，记录所基于 facts.json 的 facts_sha。
 *
 * 校验失败时列出全部问题并以非零码退出，不写文件；修正分段文件后重跑。
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Category,
  type Fact,
  type FactList,
  factsHash,
  type Irrelevant,
  type Judge,
  type JudgeItem,
  judgeProblems,
} from './judging.ts';
import type { Position } from './prepare.ts';

/** facts 建议条数范围，超出仅告警。 */
const FACT_RANGE: [number, number] = [20, 35];
/** 无关信息建议最少条数，低于仅告警。 */
const IRRELEVANT_MIN = 5;

/** 读取 JSON 文件。 */
function readJson<T>(p: string): T {
  return JSON.parse(readFileSync(p, 'utf8')) as T;
}

/** 按 <base>.json、<base>-2.json… 顺序读取分段文件；一个都没有返回 null。 */
function readParts<T>(dir: string, base: string): T[] | null {
  if (!existsSync(dir)) return null;
  const names = readdirSync(dir)
    .filter((n) => n === `${base}.json` || new RegExp(`^${base}-\\d+\\.json$`).test(n))
    .sort((a, b) => {
      const na = Number(/-(\d+)\.json$/.exec(a)?.[1] ?? 1);
      const nb = Number(/-(\d+)\.json$/.exec(b)?.[1] ?? 1);
      return na - nb;
    });
  if (!names.length) return null;
  return names.map((n) => readJson<T>(join(dir, n)));
}

/** 补零编号。 */
const pad = (prefix: string, i: number) => `${prefix}${String(i).padStart(2, '0')}`;

/** parts/facts 分段文件中的单条事实（编号与 position 由合并决定）。 */
interface FactPart {
  fact?: string;
  category?: string;
  source_indices?: unknown[];
  check_hint?: string;
  evidence_after?: string;
}

/** parts/facts/irrelevant*.json 中的单条无关信息。 */
interface IrrelevantPart {
  fact?: string;
  is_credential?: boolean;
}

/** parts/judge-<V>-<N>/rest.json 的补充内容。 */
interface RestPart {
  irrelevant?: JudgeItem[];
  unsupported_claims?: unknown;
  extra_irrelevant?: unknown;
  overall_comment?: string;
}

/** merge judge 写出的补充内容。 */
interface RestData {
  irrelevant: JudgeItem[];
  unsupported_claims: { quote?: string; reason?: string }[];
  extra_irrelevant: { content?: string; chars_estimate?: number }[];
  overall_comment: string | undefined;
}

/** 合并 facts 分段为 facts.json。校验失败时列出全部问题、置非零退出码且不写文件。 */
export function mergeFacts(dir: string): void {
  const meta = readJson<{ range: [number, number] }>(join(dir, 'meta.json'));
  const [lo, hi] = meta.range;
  const partsDir = join(dir, 'parts', 'facts');
  const problems: string[] = [];
  const facts: Fact[] = [];
  const warnings: string[] = [];

  for (const p of ['head', 'mid', 'tail'] as const) {
    const parts = readParts<FactPart[]>(partsDir, p);
    if (parts === null) {
      problems.push(`缺少分段文件 ${p}.json（该分段没有事实时也要写出空数组）`);
      continue;
    }
    parts.forEach((part, pi) => {
      if (!Array.isArray(part)) {
        problems.push(`${p}${pi ? `-${pi + 1}` : ''}.json 应为数组`);
        return;
      }
      part.forEach((x, xi) => {
        const where = `${p}${pi ? `-${pi + 1}` : ''}.json 第 ${xi + 1} 条`;
        if (typeof x.fact !== 'string' || !x.fact.trim()) problems.push(`${where} 缺少 fact`);
        if (x.category !== 'A' && x.category !== 'B' && x.category !== 'C')
          problems.push(`${where} category 应为 A/B/C，实际 ${String(x.category)}`);
        const idx = Array.isArray(x.source_indices) ? x.source_indices : [];
        const nums = idx.filter((i): i is number => typeof i === 'number');
        if (!nums.length) problems.push(`${where} 缺少 source_indices`);
        const outOfRange = nums.filter((i) => i < lo || i > hi);
        if (outOfRange.length)
          problems.push(`${where} source_indices 超出区间 [${lo}..${hi}]：${outOfRange.join(' ')}`);
        if (typeof x.check_hint !== 'string' || !x.check_hint.trim())
          problems.push(`${where} 缺少 check_hint`);
        facts.push({
          id: '',
          fact: typeof x.fact === 'string' ? x.fact : '',
          category: (x.category ?? 'C') as Category,
          position: p,
          source_indices: nums,
          check_hint: typeof x.check_hint === 'string' ? x.check_hint : '',
          ...(typeof x.evidence_after === 'string' ? { evidence_after: x.evidence_after } : {}),
        });
      });
    });
  }

  const irrelevant: Irrelevant[] = [];
  const dParts = readParts<IrrelevantPart[]>(partsDir, 'irrelevant');
  if (dParts === null) {
    problems.push('缺少分段文件 irrelevant.json（没有无关信息时也要写出空数组）');
  } else {
    dParts.forEach((part, pi) => {
      if (!Array.isArray(part)) {
        problems.push(`irrelevant${pi ? `-${pi + 1}` : ''}.json 应为数组`);
        return;
      }
      part.forEach((x, xi) => {
        const where = `irrelevant${pi ? `-${pi + 1}` : ''}.json 第 ${xi + 1} 条`;
        if (typeof x.fact !== 'string' || !x.fact.trim()) problems.push(`${where} 缺少 fact`);
        irrelevant.push({
          id: '',
          fact: typeof x.fact === 'string' ? x.fact : '',
          is_credential: x.is_credential === true,
        });
      });
    });
  }

  if (problems.length) {
    for (const p of problems) console.error(p);
    process.exitCode = 1;
    return;
  }

  facts.forEach((f, i) => {
    f.id = pad('F', i + 1);
  });
  irrelevant.forEach((d, i) => {
    d.id = pad('D', i + 1);
  });
  if (facts.length < FACT_RANGE[0] || facts.length > FACT_RANGE[1])
    warnings.push(`关键事实 ${facts.length} 条，建议 ${FACT_RANGE[0]}–${FACT_RANGE[1]} 条`);
  if (irrelevant.length < IRRELEVANT_MIN)
    warnings.push(`无关信息 ${irrelevant.length} 条，建议至少 ${IRRELEVANT_MIN} 条`);
  const fj: FactList = { facts, irrelevant };
  writeFileSync(join(dir, 'facts.json'), JSON.stringify(fj, null, 1), 'utf8');
  const byPos = (p: Position) => facts.filter((f) => f.position === p).length;
  console.log(
    `facts.json：关键事实 ${facts.length} 条（head ${byPos('head')} / mid ${byPos('mid')} / tail ${byPos('tail')}），无关信息 ${irrelevant.length} 条，facts_sha ${factsHash(fj).slice(0, 12)}`,
  );
  for (const w of warnings) console.warn(`告警：${w}`);
}

/** 合并评审分段为 judge-<V>-<N>.json，写入所依据 facts.json 的哈希。 */
export function mergeJudge(dir: string, v: string, n: string): void {
  const fj = readJson<FactList>(join(dir, 'facts.json'));
  const partsDir = join(dir, 'parts', `judge-${v}-${n}`);
  const problems: string[] = [];
  const factItems: JudgeItem[] = [];

  for (const p of ['head', 'mid', 'tail'] as const) {
    const expected = fj.facts.filter((f) => f.position === p);
    const part = readParts<JudgeItem[]>(partsDir, p);
    if (part === null) {
      if (expected.length)
        problems.push(`缺少分段文件 ${p}.json（应含 ${expected.map((f) => f.id).join(' ')}）`);
      continue;
    }
    part.forEach((xs, pi) => {
      if (!Array.isArray(xs)) {
        problems.push(`${p}${pi ? `-${pi + 1}` : ''}.json 应为数组`);
        return;
      }
      xs.forEach((x) => {
        const f = fj.facts.find((y) => y.id === x.id);
        if (f && f.position !== p)
          problems.push(`事实 ${x.id} 属于 ${f.position}，被写在 ${p}.json`);
        factItems.push(x);
      });
    });
  }

  const rest = readParts<RestPart>(partsDir, 'rest');
  let restData: RestData = {
    irrelevant: [],
    unsupported_claims: [],
    extra_irrelevant: [],
    overall_comment: undefined,
  };
  if (rest === null) {
    problems.push('缺少分段文件 rest.json（应含无关信息判定与清单外内容）');
  } else if (rest.length > 1) {
    problems.push('rest.json 只允许一个文件');
  } else {
    const r = rest[0];
    if (!r) problems.push('rest.json 内容为空');
    else
      restData = {
        irrelevant: Array.isArray(r.irrelevant) ? r.irrelevant : [],
        unsupported_claims: Array.isArray(r.unsupported_claims) ? r.unsupported_claims : [],
        extra_irrelevant: Array.isArray(r.extra_irrelevant) ? r.extra_irrelevant : [],
        overall_comment: typeof r.overall_comment === 'string' ? r.overall_comment : undefined,
      };
  }

  const judge: Judge = {
    facts: factItems,
    irrelevant: restData.irrelevant,
    unsupported_claims: restData.unsupported_claims,
    extra_irrelevant: restData.extra_irrelevant,
    ...(restData.overall_comment !== undefined
      ? { overall_comment: restData.overall_comment }
      : {}),
    facts_sha: factsHash(fj),
  };
  problems.push(...judgeProblems(judge, fj, `judge-${v}-${n}`));

  if (problems.length) {
    for (const p of problems) console.error(p);
    process.exitCode = 1;
    return;
  }

  const name = `judge-${v}-${n}.json`;
  writeFileSync(join(dir, name), JSON.stringify(judge, null, 1), 'utf8');
  console.log(
    `${name}：事实判定 ${judge.facts.length} 条，无关信息判定 ${judge.irrelevant.length} 条，无依据断言 ${judge.unsupported_claims?.length ?? 0} 条，清单外无关内容 ${judge.extra_irrelevant?.length ?? 0} 条`,
  );
}

/** 命令行入口。 */
function main(): void {
  const [cmd, dir, v, n] = process.argv.slice(2);
  if (cmd === 'facts' && dir) {
    mergeFacts(resolve(dir));
    return;
  }
  if (cmd === 'judge' && dir && v && n) {
    mergeJudge(resolve(dir), v, n);
    return;
  }
  console.error('用法：node merge.ts facts <评估目录> | merge.ts judge <评估目录> <V> <N>');
  process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
