/**
 * 准备压缩质量评估数据：定位主会话的压缩日志，按区间分组，导出盲化变体、原文、后续轨迹与规则。
 *
 * 用法：node prepare.ts (--session <主会话 id 或前缀> | --zip <会话日志 zip>)
 *       [--variants 目录]... [--range A..B] [--phase observe|reflect] [--out 目录] [--seed N]
 *       [--after-max N] [--list]
 * 输入：本地 ~/.dsh/sessions，或 DSH 导出的会话日志 zip，需含 subagents；
 *       --variants 可重复，并入 compress.ts 产出目录中的压缩日志。
 * --list 只列出各区间的候选与 token，不写评估目录；正常运行也先打印同一列表。
 * 产出：V*.xml、source.xml、after.md、rules.md、_blind_key.json、meta.json；
 *       after.md 为区间终点完整消息之后的轨迹，只含用户消息、手动加载的 skill、
 *       助手正文、工具调用与压缩标记；缺省写入系统临时目录下的
 *       om-compaction-eval/eval-<会话 id 前 8 位>-<阶段>-<A>-<B>/。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { SKILL_INVOCATION_KIND } from '../../../../src/constants.ts';
import { indexCompleteMessages } from '../../../../src/log-index.ts';
import { bareId, evalPath } from './paths.ts';
import {
  type Content,
  type EventData,
  loadBundle,
  loadVariants,
  type SessionEvent,
  toSession,
} from './session-source.ts';

/** getHistory 的区间参数。 */
interface HistoryArgs {
  start?: number;
  end?: number;
}

/** 压缩阶段：观察、反思，或旧日志中的未知阶段。 */
export type Phase = 'observe' | 'reflect' | 'unknown';

/** 单个压缩日志的解析结果。 */
export interface CompactionLog {
  id: string;
  parent: string | undefined;
  range: [number, number] | undefined;
  phase: Phase;
  failed: boolean;
  model: string;
  effort: string;
  recompress: boolean;
  wall_sec: number;
  /** 逐轮模型请求耗时之和（秒），不含限流等待。 */
  model_sec: number;
  requests: number;
  /** 计费输入 token：未缓存输入 + 缓存读 + 缓存写，逐轮求和。 */
  tokens_in: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  tokens_out: number;
  product: string;
  /** 首次成功 compressHistory 之前的 getHistory 参数与结果。 */
  views: [HistoryArgs, string][];
  created: number;
}

/** 盲化映射中记录的变体信息。 */
export type BlindEntry = Pick<
  CompactionLog,
  | 'id'
  | 'model'
  | 'effort'
  | 'recompress'
  | 'wall_sec'
  | 'model_sec'
  | 'requests'
  | 'tokens_in'
  | 'tokens_cache_read'
  | 'tokens_cache_write'
  | 'tokens_out'
>;

/** 位置分段名。 */
export type Position = 'head' | 'mid' | 'tail';

/** 区间三等分：分段名 → [起, 止]。 */
export type Buckets = Record<Position, [number, number]>;

/** 压缩指令中的区间。 */
const RANGE_RE = /区间 \[(\d+)\.\.(\d+)\]/;
/** 压缩日志尾部的模型说明；思考等级可为中文（如「默认思考等级」）。 */
const MODEL_RE = /压缩使用模型 (\S+?)（([^）]+)）/;
/** 评估目录中表明评审已开始的产物：重写候选会让它们对上新的编号。 */
const REVIEW_RE = /^(facts\.json|judge-.+\.json|parts)$/;
/** 重写候选前清除的旧产物：候选变少时残留的 V*.xml 与旧评分。 */
const STALE_RE = /^(V\d+\.xml|scores\.(json|md))$/;

/** 准备评估目录：已有事实清单、评审或分段产物时报错；否则建目录并清除旧候选与评分。 */
export function prepareEvalDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const names = readdirSync(dir);
  const reviewed = names.filter((n) => REVIEW_RE.test(n)).sort();
  if (reviewed.length)
    throw new Error(
      `评估目录已有评审产物 ${reviewed.join('、')}：${dir}。重评同一区间前先删除该目录`,
    );
  for (const n of names) if (STALE_RE.test(n)) rmSync(join(dir, n));
}

/** 拼接消息 content 中的文本。 */
function textOf(content: Content[] | undefined): string {
  return (content ?? []).map((c) => c.text ?? '').join('');
}

/** callId → tool/result data。 */
function resultsByCall(events: SessionEvent[]): Map<string, EventData> {
  const out = new Map<string, EventData>();
  for (const e of events) {
    if (e.type !== 'tool/result' || !e.data) continue;
    const id = e.data.callId ?? e.data.message?.toolCallId;
    if (id) out.set(id, e.data);
  }
  return out;
}

/** 逐轮模型请求耗时之和：step/start 到该轮 assistant/message，限流等待不计入。 */
function modelSeconds(body: SessionEvent[]): number {
  let ms = 0;
  let start: number | undefined;
  for (const e of body) {
    if (e.type === 'step/start') start = e.time;
    else if (e.type === 'assistant/message' && start !== undefined && typeof e.time === 'number') {
      ms += e.time - start;
      start = undefined;
    }
  }
  return Math.round(ms / 100) / 10;
}

/** 解析单个压缩日志：阶段、区间、模型、耗时、token、产物与原文视图。 */
export function parseLog(events: SessionEvent[]): CompactionLog {
  const [head, ...body] = events;
  if (!head?.id) throw new Error('日志缺少会话头');
  const label = body.find((e) => e.type === 'subagent/descriptor')?.data?.label ?? '';
  const firstUser = textOf(body.find((e) => e.type === 'user/message')?.data?.content);
  const rng = RANGE_RE.exec(firstUser);
  const assistants = body.filter((e) => e.type === 'assistant/message');
  const model = assistants
    .map((e) => MODEL_RE.exec(textOf(e.data?.message?.content)))
    .filter((m) => m !== null)
    .at(-1);
  const usage = assistants.flatMap((e) => (e.data?.usage ? [e.data.usage] : []));
  const times = body.flatMap((e) => (typeof e.time === 'number' ? [e.time] : []));
  const res = resultsByCall(body);
  // 产物取 completeCompression 调用的 result；同轮后续调用会被补「未执行」记录，不能取最后一个 result
  const cc = body.find(
    (e) => e.type === 'tool/call' && e.data?.name === 'completeCompression' && e.data.callId,
  );
  const ccRes = cc?.data?.callId ? res.get(cc.data.callId) : undefined;
  const product = ccRes && !ccRes.message?.isError ? textOf(ccRes.message?.content) : '';
  // 原文视图只取首次成功 compressHistory 之前的 getHistory：之后的视图显示本次摘要
  const views: [HistoryArgs, string][] = [];
  for (const e of body) {
    if (e.type !== 'tool/call' || !e.data?.callId) continue;
    const r = res.get(e.data.callId);
    if (!r || r.message?.isError) continue;
    if (e.data.name === 'compressHistory') break;
    if (e.data.name === 'getHistory')
      views.push([JSON.parse(e.data.arguments || '{}') as HistoryArgs, textOf(r.message?.content)]);
  }
  return {
    id: head.id,
    parent: head.parentSession,
    range: rng ? [Number(rng[1]), Number(rng[2])] : undefined,
    phase: label.includes('观察') ? 'observe' : label.includes('反思') ? 'reflect' : 'unknown',
    failed: label.includes('失败日志'),
    model: model?.[1] ?? 'unknown',
    effort: model?.[2] ?? 'unknown',
    recompress: label.includes('重压缩'),
    wall_sec: times.length ? Math.round((Math.max(...times) - Math.min(...times)) / 100) / 10 : 0,
    model_sec: modelSeconds(body),
    requests: usage.length,
    tokens_in: usage.reduce(
      (s, u) => s + (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0),
      0,
    ),
    tokens_cache_read: usage.reduce((s, u) => s + (u.cacheReadTokens ?? 0), 0),
    tokens_cache_write: usage.reduce((s, u) => s + (u.cacheWriteTokens ?? 0), 0),
    tokens_out: usage.reduce((s, u) => s + (u.outputTokens ?? 0), 0),
    product,
    views,
    created: head.createdAt ?? 0,
  };
}

/** 取覆盖整个区间的 getHistory 视图作为原文，优先原始压缩日志。 */
export function pickSource(logs: CompactionLog[], lo: number, hi: number): string {
  const ordered = [...logs].sort((a, b) => Number(a.recompress) - Number(b.recompress));
  for (const log of ordered) {
    for (const [args, view] of log.views) {
      if ((args.start ?? lo) === lo && (args.end ?? hi) === hi) return view;
    }
  }
  const size = (l: CompactionLog) => l.views.reduce((s, [, v]) => s + v.length, 0);
  const best = ordered.reduce((a, b) => (size(b) > size(a) ? b : a));
  return best.views.map(([, v]) => v).join('\n');
}

/** 去掉注释，省略逐字保留的 skill 原文。 */
export function blindProduct(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(
      /(<skill_content[^>]*>)[\s\S]*?(<\/skill_content>)/g,
      '$1[skill 原文逐字保留，已省略]$2',
    );
}

/** 主会话中区间终点完整消息之后的真实轨迹，超过 limit 字符截断。 */
export function buildAfter(
  main: SessionEvent[],
  hi: number,
  limit: number,
): { text: string; start: number } {
  const cms = indexCompleteMessages(toSession(main));
  const target = cms[hi];
  if (!target) throw new Error(`主会话中找不到完整消息 ${hi}，无法定位后续轨迹起点`);
  const start = Math.max(...target.seqs) + 1;
  const res = resultsByCall(main);
  const out: string[] = [];
  let size = 0;
  // seq 与去掉会话头后的日志下标一致，故从 main[start + 1] 起遍历
  for (const e of main.slice(start + 1)) {
    const d = e.data;
    let line = '';
    if (e.type === 'user/message') {
      const txt = textOf(d?.content).slice(0, 1500);
      if (d?.source?.kind === 'user') line = `[USER] ${txt}`;
      else if (d?.source?.kind === SKILL_INVOCATION_KIND && d.source.name)
        line = `[SKILL ${d.source.name}] ${txt}`;
    } else if (e.type === 'assistant/message') {
      const txt = (d?.message?.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('')
        .trim();
      if (txt) line = `[ASSISTANT] ${txt.slice(0, 2500)}`;
    } else if (e.type === 'tool/call' && d?.callId) {
      const rt = textOf(res.get(d.callId)?.message?.content);
      line = `[TOOL ${d.name}] args=${(d.arguments ?? '').slice(0, 300)}\n  result=${rt.slice(0, 600)}`;
    } else if (e.type.startsWith('compaction/') && e.type !== 'compaction/summary') {
      line = `===== ${e.type} =====`;
    }
    if (!line) continue;
    out.push(line);
    size += line.length;
    if (size > limit) {
      out.push(`[后续轨迹超过 ${limit} 字符，已截断]`);
      break;
    }
  }
  return { text: out.join('\n'), start };
}

/** 各位置分段在 source.xml 中的行区间（1 起、含端点）；分段无条目时为 null。 */
export function segmentLines(
  source: string,
  bk: Buckets,
): Record<Position, [number, number] | null> {
  const lines = source.split('\n');
  const bucketOf = (index: number): Position =>
    index <= bk.head[1] ? 'head' : index <= bk.mid[1] ? 'mid' : 'tail';
  const entries: { line: number; index: number | undefined }[] = [];
  let inCdata = false;
  lines.forEach((line, i) => {
    if (!inCdata) {
      const tag = /^<([a-zA-Z_-]+)[^>]*>/.exec(line);
      if (tag) {
        const idx = /\b(?:index|start)="(\d+)"/.exec(tag[0]);
        entries.push({ line: i + 1, index: idx ? Number(idx[1]) : undefined });
      }
    }
    for (const m of line.matchAll(/<!\[CDATA\[|\]\]>/g)) inCdata = m[0] === '<![CDATA[';
  });
  // 无 index 条目（reasoning 等）随其后第一个有 index 的条目分段；其后没有时沿用前一个
  const bucketsArr: (Position | undefined)[] = new Array(entries.length);
  let carry: Position | undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    const index = entries[i]?.index;
    if (index !== undefined) carry = bucketOf(index);
    bucketsArr[i] = carry;
  }
  carry = 'head';
  for (let i = 0; i < entries.length; i++) {
    const b = bucketsArr[i];
    if (b === undefined) bucketsArr[i] = carry;
    else carry = b;
  }
  const firsts = new Map<Position, number>();
  entries.forEach((e, i) => {
    const b = bucketsArr[i];
    if (b && !firsts.has(b)) firsts.set(b, e.line);
  });
  const order: Position[] = ['head', 'mid', 'tail'];
  const lastLine = lines.length - (lines.at(-1) === '' ? 1 : 0);
  const out = {} as Record<Position, [number, number] | null>;
  order.forEach((p, i) => {
    const first = firsts.get(p);
    if (first === undefined) {
      out[p] = null;
      return;
    }
    let end = lastLine;
    for (const q of order.slice(i + 1)) {
      const nf = firsts.get(q);
      if (nf !== undefined) {
        end = nf - 1;
        break;
      }
    }
    out[p] = [first, end];
  });
  return out;
}

/** 把区间按 index 三等分为 head/mid/tail。 */
export function buckets(lo: number, hi: number): Buckets {
  const n = hi - lo + 1;
  const third = Math.ceil(n / 3);
  const h = lo + third - 1;
  const m = h + Math.floor((n - third) / 2);
  return { head: [lo, h], mid: [h + 1, m], tail: [m + 1, hi] };
}

/** 带种子的 Fisher-Yates 洗牌，保证盲化编号可复现。 */
export function shuffle<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** 按「阶段|区间」分组。 */
export function groupLogs(logs: CompactionLog[]): Map<string, CompactionLog[]> {
  const groups = new Map<string, CompactionLog[]>();
  for (const x of logs) {
    const k = `${x.phase}|${x.range?.join('..') ?? '?'}`;
    groups.set(k, [...(groups.get(k) ?? []), x]);
  }
  return groups;
}

/** 候选列表文本：每组一行标题，组内每候选一行（来源、模型、等级、token、耗时、产物长度）。 */
export function formatCandidates(logs: CompactionLog[]): string[] {
  const lines: string[] = [];
  for (const g of groupLogs(logs).values()) {
    const head = g.at(0);
    if (!head?.range) continue;
    lines.push(`区间 [${head.range.join('..')}] ${head.phase}：${g.length} 个候选`);
    for (const x of g) {
      const cache =
        x.tokens_cache_read || x.tokens_cache_write
          ? `（缓存读 ${x.tokens_cache_read}/写 ${x.tokens_cache_write}）`
          : '';
      lines.push(
        `  ${x.recompress ? '重压缩' : '原始'} ${x.model}（${x.effort}）in=${x.tokens_in}${cache} out=${x.tokens_out} 模型 ${x.model_sec}s 产物 ${x.product.length} 字符`,
      );
    }
  }
  return lines;
}

/** 选中的评估组。 */
export interface SelectedGroup {
  phase: Phase;
  lo: number;
  hi: number;
  logs: CompactionLog[];
}

/** 规范化 --phase 取值，接受中英文。 */
function normPhase(v: string | undefined): Phase | undefined {
  if (v === undefined) return undefined;
  if (v === 'observe' || v === '观察') return 'observe';
  if (v === 'reflect' || v === '反思') return 'reflect';
  throw new Error(`--phase 仅支持 observe/reflect：${v}`);
}

/**
 * 按 --range/--phase 选择评估组；缺省选变体最多（并列取最新）的组。
 * 同一区间同时存在观察与反思日志时必须指定 --phase：两者输入不同，不可同组比较。
 */
export function selectGroup(
  logs: CompactionLog[],
  range?: string,
  phaseArg?: string,
): SelectedGroup {
  const phase = normPhase(phaseArg);
  const match = [...groupLogs(logs)].filter(([k, g]) => {
    const [p, r] = k.split('|');
    return g.length > 0 && (!range || r === range) && (!phase || p === phase);
  });
  if (!match.length)
    throw new Error(
      `没有匹配的压缩日志${range ? `（区间 ${range}${phase ? `，阶段 ${phase}` : ''}）` : ''}`,
    );
  if (range && !phase) {
    const phases = new Set(match.map(([k]) => k.split('|')[0]));
    if (phases.size > 1)
      throw new Error(
        `区间 [${range}] 同时有 ${[...phases].join('、')} 阶段日志，请用 --phase 指定`,
      );
  }
  const latest = (g: CompactionLog[]) => Math.max(...g.map((x) => x.created));
  const [, group] = match.reduce((a, b) =>
    b[1].length > a[1].length || (b[1].length === a[1].length && latest(b[1]) > latest(a[1]))
      ? b
      : a,
  );
  const first = group.at(0);
  if (!first?.range) throw new Error('选中的组缺少区间信息');
  const [lo, hi] = first.range;
  return { phase: first.phase, lo, hi, logs: group };
}

/** 写 UTF-8 文本文件。 */
function write(dir: string, name: string, text: string): void {
  writeFileSync(join(dir, name), text, 'utf8');
}

/** 命令行入口。 */
function main(): void {
  const { values } = parseArgs({
    options: {
      session: { type: 'string' },
      zip: { type: 'string' },
      variants: { type: 'string', multiple: true },
      range: { type: 'string' },
      phase: { type: 'string' },
      out: { type: 'string' },
      seed: { type: 'string', default: '20261015' },
      'after-max': { type: 'string', default: '60000' },
      list: { type: 'boolean' },
    },
  });
  const bundle = loadBundle(values);
  const mainEv = bundle.main;
  const mainHead = mainEv[0];
  if (!mainHead?.id) throw new Error('主会话缺少会话头');
  const mainId = bareId(mainHead.id);
  const logs = [...bundle.logs, ...(values.variants ?? []).flatMap(loadVariants)]
    .map(parseLog)
    .filter((x) => !x.failed && bareId(x.parent ?? '') === mainId && x.range);
  if (!logs.length) throw new Error('该会话没有可用的压缩日志');
  for (const line of formatCandidates(logs)) console.log(line);
  if (values.list) return;
  const sel = selectGroup(logs, values.range, values.phase);
  const { lo, hi, logs: group } = sel;
  for (const x of group) {
    if (!x.product) throw new Error(`变体 ${x.id} 缺少 completeCompression 产物`);
  }

  const out = values.out ? resolve(values.out) : evalPath(mainId, sel.phase, lo, hi);
  prepareEvalDir(out);
  const source = pickSource(group, lo, hi);
  write(out, 'source.xml', source);

  const key: Record<string, BlindEntry> = {};
  shuffle(group, Number(values.seed)).forEach((x, i) => {
    const v = `V${i + 1}`;
    write(out, `${v}.xml`, blindProduct(x.product));
    const {
      id,
      model,
      effort,
      recompress,
      wall_sec,
      model_sec,
      requests,
      tokens_in,
      tokens_cache_read,
      tokens_cache_write,
      tokens_out,
    } = x;
    key[v] = {
      id,
      model,
      effort,
      recompress,
      wall_sec,
      model_sec,
      requests,
      tokens_in,
      tokens_cache_read,
      tokens_cache_write,
      tokens_out,
    };
  });
  write(out, '_blind_key.json', JSON.stringify(key, null, 1));

  const after = buildAfter(mainEv, hi, Number(values['after-max']));
  write(out, 'after.md', after.text);

  const bk = buckets(lo, hi);
  const seg = segmentLines(source, bk);
  const lineRange = (r: [number, number] | null): string => (r ? `${r[0]}–${r[1]}` : '-');
  const task = /<user_message[^>]*><!\[CDATA\[([\s\S]*?)\]\]>/
    .exec(source)?.[1]
    ?.trim()
    .slice(0, 500);
  const tplPath = join(import.meta.dirname, '..', 'references', 'rules.md');
  if (!existsSync(tplPath)) throw new Error(`缺少规则模板：${tplPath}`);
  const fill: Record<string, string> = {
    lo: String(lo),
    hi: String(hi),
    phase: sel.phase === 'reflect' ? '反思' : sel.phase === 'observe' ? '观察' : '压缩',
    task: task ?? '（见 source.xml）',
    head: bk.head.join('–'),
    mid: bk.mid.join('–'),
    tail: bk.tail.join('–'),
    head_lines: lineRange(seg.head),
    mid_lines: lineRange(seg.mid),
    tail_lines: lineRange(seg.tail),
  };
  write(
    out,
    'rules.md',
    readFileSync(tplPath, 'utf8').replace(/\{(\w+)\}/g, (m, k: string) => fill[k] ?? m),
  );
  const meta = {
    session: mainId,
    phase: sel.phase,
    range: [lo, hi],
    buckets: bk,
    segment_lines: seg,
    variants: Object.keys(key),
    after_start_seq: after.start,
  };
  write(out, 'meta.json', JSON.stringify(meta, null, 1));
  console.log(`输出目录：${out}`);
  console.log(
    `变体 ${group.length} 个，原文 ${source.length} 字符，后续轨迹 ${after.text.length} 字符，分段 ${JSON.stringify(bk)}`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
