/**
 * 准备压缩质量评估数据：定位主会话的压缩日志，按区间分组，导出盲化变体、原文、后续轨迹与规则。
 *
 * 用法：node prepare.ts (--session <主会话 id 或前缀> | --zip <会话日志 zip>)
 *       [--range A..B] [--phase observe|reflect] [--out 目录] [--seed N] [--after-max N]
 * 输入：本地 ~/.dsh/sessions，或 DSH 导出的会话日志 zip，需含 subagents。
 * 产出：V*.xml、source.xml、after.md、rules.md、_blind_key.json、meta.json。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { unzipSync } from 'fflate';
import { decompress } from 'fzstd';

/** 消息内容片段。 */
interface Content {
  type: string;
  text?: string;
}

/** token 用量。 */
interface Usage {
  inputTokens?: number;
  outputTokens?: number;
}

/** 会话事件 data 中用到的字段。 */
interface EventData {
  label?: string;
  content?: Content[];
  message?: { content: Content[]; toolCallId?: string; isError?: boolean };
  usage?: Usage;
  callId?: string;
  name?: string;
  arguments?: string;
}

/** 会话日志一行：首行为会话头，其余为事件。 */
export interface SessionEvent {
  type: string;
  time?: number;
  id?: string;
  parentSession?: string;
  createdAt?: number;
  cwd?: string;
  data?: EventData;
}

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
  tokens_in: number;
  tokens_out: number;
  product: string;
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
  | 'tokens_out'
>;

/** 位置分段名。 */
export type Position = 'head' | 'mid' | 'tail';

/** 区间三等分：分段名 → [起, 止]。 */
export type Buckets = Record<Position, [number, number]>;

/** 主会话及其候选压缩日志的原始事件。 */
export interface SessionBundle {
  main: SessionEvent[];
  logs: SessionEvent[][];
}

/** 会话根目录。 */
const SESSIONS = join(homedir(), '.dsh', 'sessions');
/** 压缩指令中的区间。 */
const RANGE_RE = /区间 \[(\d+)\.\.(\d+)\]/;
/** 压缩日志尾部的模型说明；思考等级可为中文（如「默认思考等级」）。 */
const MODEL_RE = /压缩使用模型 (\S+?)（([^）]+)）/;

/** 导出 zip 中的根会话日志。 */
const ZIP_MAIN_RE = /^session(\.v\d+)?\.jsonl$/;
/** 导出 zip 中的压缩日志。 */
const ZIP_LOG_RE = /^subagents\/om-compaction-log-[^/]+\/session(\.v\d+)?\.jsonl$/;

/** 解析 jsonl 文本为事件列表。 */
function parseJsonl(text: string): SessionEvent[] {
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as SessionEvent);
}

/** 读取会话日志：多帧 zstd 追加写入或已解压 jsonl。 */
export function loadLog(path: string): SessionEvent[] {
  const raw = readFileSync(path);
  return parseJsonl(
    path.endsWith('.zstd') ? new TextDecoder().decode(decompress(raw)) : raw.toString('utf8'),
  );
}

/** 读取 DSH 导出的会话日志 zip：根日志为主会话，subagents 下的 om-compaction-log-* 为压缩日志。 */
export function readZip(path: string): SessionBundle {
  const files = unzipSync(readFileSync(path), {
    filter: (f) => ZIP_MAIN_RE.test(f.name) || ZIP_LOG_RE.test(f.name),
  });
  const entries = Object.entries(files);
  const decode = (bytes: Uint8Array) => parseJsonl(new TextDecoder().decode(bytes));
  const main = entries.find(([name]) => ZIP_MAIN_RE.test(name));
  if (!main) throw new Error(`zip 中未找到根会话日志：${path}`);
  const logs = entries.filter(([name]) => ZIP_LOG_RE.test(name)).map(([, bytes]) => decode(bytes));
  if (!logs.length) throw new Error(`zip 中没有压缩日志，导出时需包含 subagents：${path}`);
  return { main: decode(main[1]), logs };
}

/** 会话目录下的日志文件。 */
function logFile(sessionDir: string): string {
  const name = readdirSync(sessionDir).find((f) => /^session\..*\.jsonl/.test(f));
  if (!name) throw new Error(`未找到日志文件：${sessionDir}`);
  return join(sessionDir, name);
}

/** 会话 id 规范化：parentSession 带 session- 前缀，目录名与头 id 为裸 uuid。 */
export function bareId(id: string): string {
  return id.replace(/^session-/, '');
}

/** 评估目录名：eval-<会话 id 前 8 位>-<阶段>-<A>-<B>。 */
export function evalDirName(sessionId: string, phase: Phase, lo: number, hi: number): string {
  return `eval-${bareId(sessionId).slice(0, 8)}-${phase}-${lo}-${hi}`;
}

/** 在全部工作区中按 id 前缀定位主会话目录。 */
function findMain(prefix: string): string {
  const p = bareId(prefix);
  const hits = readdirSync(SESSIONS).flatMap((ws) => {
    const dir = join(SESSIONS, ws);
    if (!statSync(dir).isDirectory()) return [];
    return readdirSync(dir)
      .filter((d) => bareId(d).startsWith(p) && !d.startsWith('om-compaction-log'))
      .map((d) => join(dir, d))
      .filter((d) => statSync(d).isDirectory());
  });
  const [hit] = hits;
  if (hits.length !== 1 || !hit)
    throw new Error(`会话前缀 ${prefix} 匹配 ${hits.length} 个目录：${hits.join(', ')}`);
  return hit;
}

/** 读取本地会话：按 id 前缀定位主会话，压缩日志取同一工作区目录。 */
function loadLocal(prefix: string): SessionBundle {
  const mainDir = findMain(prefix);
  const wsDir = dirname(mainDir);
  const logs = readdirSync(wsDir)
    .filter((d) => d.startsWith('om-compaction-log-'))
    .map((d) => loadLog(logFile(join(wsDir, d))));
  return { main: loadLog(logFile(mainDir)), logs };
}

/** 按 --session 前缀或 --zip 路径读取会话，二者恰选其一。 */
export function loadBundle(source: { session?: string; zip?: string }): SessionBundle {
  if (!source.session === !source.zip) throw new Error('需指定 --session 或 --zip 之一');
  return source.zip ? readZip(resolve(source.zip)) : loadLocal(source.session ?? '');
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
  const views: [HistoryArgs, string][] = [];
  for (const e of body) {
    if (e.type !== 'tool/call' || e.data?.name !== 'getHistory' || !e.data.callId) continue;
    const r = res.get(e.data.callId);
    if (r && !r.message?.isError)
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
    tokens_in: usage.reduce((s, u) => s + (u.inputTokens ?? 0), 0),
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
  return best.views.map(([, v]) => v).join('');
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

/** 主会话中自区间最后一个工具调用起的后续轨迹，超过 limit 字符截断。 */
export function buildAfter(
  main: SessionEvent[],
  source: string,
  limit: number,
): { text: string; start: number } {
  const lastCall = [...source.matchAll(/callId="([^"]+)"/g)].at(-1)?.[1];
  if (!lastCall) throw new Error('source.xml 中没有 callId，无法定位后续轨迹起点');
  const start = main.findIndex((e) => e.type === 'tool/call' && e.data?.callId === lastCall);
  if (start < 0) throw new Error(`主会话中找不到区间末尾的工具调用 ${lastCall}`);
  const res = resultsByCall(main);
  const out: string[] = [];
  let size = 0;
  for (const e of main.slice(start)) {
    const d = e.data;
    let line = '';
    if (e.type === 'user/message') {
      const txt = textOf(d?.content);
      if (!txt.includes('<system-reminder>') && !txt.startsWith('## MCP'))
        line = `[USER] ${txt.slice(0, 1500)}`;
    } else if (e.type === 'assistant/message') {
      const txt = textOf(d?.message?.content).trim();
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
      range: { type: 'string' },
      phase: { type: 'string' },
      out: { type: 'string' },
      seed: { type: 'string', default: '20261015' },
      'after-max': { type: 'string', default: '60000' },
    },
  });
  const zip = values.zip ? resolve(values.zip) : undefined;
  const bundle = loadBundle(values);
  const mainEv = bundle.main;
  const mainHead = mainEv[0];
  if (!mainHead?.id) throw new Error('主会话缺少会话头');
  const mainId = bareId(mainHead.id);
  const logs = bundle.logs
    .map(parseLog)
    .filter((x) => !x.failed && bareId(x.parent ?? '') === mainId && x.range);
  if (!logs.length) throw new Error('该会话没有可用的压缩日志');
  for (const g of groupLogs(logs).values()) {
    const head = g.at(0);
    if (!head) continue;
    console.log(
      `区间 [${head.range?.join('..')}] ${head.phase}：${g.length} 个变体 ${g.map((x) => `${x.model}(${x.effort})`).join('、')}`,
    );
  }
  const sel = selectGroup(logs, values.range, values.phase);
  const { lo, hi, logs: group } = sel;
  for (const x of group) {
    if (!x.product) throw new Error(`变体 ${x.id} 缺少 completeCompression 产物`);
  }

  const name = evalDirName(mainId, sel.phase, lo, hi);
  const out =
    values.out ??
    (zip
      ? join(dirname(zip), basename(zip, extname(zip)), name)
      : join(mainHead.cwd ?? '.', '.session-snapshots', name));
  mkdirSync(out, { recursive: true });
  const source = pickSource(group, lo, hi);
  write(out, 'source.xml', source);

  const key: Record<string, BlindEntry> = {};
  shuffle(group, Number(values.seed)).forEach((x, i) => {
    const v = `V${i + 1}`;
    write(out, `${v}.xml`, blindProduct(x.product));
    const { id, model, effort, recompress, wall_sec, model_sec, requests, tokens_in, tokens_out } =
      x;
    key[v] = {
      id,
      model,
      effort,
      recompress,
      wall_sec,
      model_sec,
      requests,
      tokens_in,
      tokens_out,
    };
  });
  write(out, '_blind_key.json', JSON.stringify(key, null, 1));

  const after = buildAfter(mainEv, source, Number(values['after-max']));
  write(out, 'after.md', after.text);

  const bk = buckets(lo, hi);
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
    variants: Object.keys(key),
    after_start_event: after.start,
  };
  write(out, 'meta.json', JSON.stringify(meta, null, 1));
  console.log(`输出目录：${out}`);
  console.log(
    `变体 ${group.length} 个，原文 ${source.length} 字符，后续轨迹 ${after.text.length} 字符，分段 ${JSON.stringify(bk)}`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
