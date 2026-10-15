/**
 * 准备压缩质量评估数据：定位主会话的压缩日志，按区间分组，导出盲化变体、原文、后续轨迹与规则。
 *
 * 用法：node prepare.ts --session <主会话 id 或前缀> [--range A..B] [--out 目录] [--seed N] [--after-max N]
 * 产出：V*.xml、source.xml、after.md、rules.md、_blind_key.json、meta.json。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
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
  message?: { content: Content[]; toolCallId?: string };
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

/** 单个压缩日志的解析结果。 */
export interface CompactionLog {
  id: string;
  parent: string | undefined;
  range: [number, number] | undefined;
  model: string;
  effort: string;
  recompress: boolean;
  wall_sec: number;
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
  'id' | 'model' | 'effort' | 'recompress' | 'wall_sec' | 'requests' | 'tokens_in' | 'tokens_out'
>;

/** 位置分段名。 */
export type Position = 'head' | 'mid' | 'tail';

/** 区间三等分：分段名 → [起, 止]。 */
export type Buckets = Record<Position, [number, number]>;

/** 会话根目录。 */
const SESSIONS = join(homedir(), '.dsh', 'sessions');
/** 压缩指令中的区间。 */
const RANGE_RE = /区间 \[(\d+)\.\.(\d+)\]/;
/** 压缩日志尾部的模型说明。 */
const MODEL_RE = /压缩使用模型 (\S+?)（(\w+)）/;

/** 读取会话日志：多帧 zstd 追加写入或已解压 jsonl。 */
export function loadLog(path: string): SessionEvent[] {
  const raw = readFileSync(path);
  const text = path.endsWith('.zstd')
    ? new TextDecoder().decode(decompress(raw))
    : raw.toString('utf8');
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as SessionEvent);
}

/** 会话目录下的日志文件。 */
function logFile(sessionDir: string): string {
  const name = readdirSync(sessionDir).find((f) => /^session\..*\.jsonl/.test(f));
  if (!name) throw new Error(`未找到日志文件：${sessionDir}`);
  return join(sessionDir, name);
}

/** 在全部工作区中按 id 前缀定位主会话目录。 */
function findMain(prefix: string): string {
  const hits = readdirSync(SESSIONS).flatMap((ws) => {
    const dir = join(SESSIONS, ws);
    if (!statSync(dir).isDirectory()) return [];
    return readdirSync(dir)
      .filter((d) => d.includes(prefix) && !d.startsWith('om-compaction-log'))
      .map((d) => join(dir, d))
      .filter((d) => statSync(d).isDirectory());
  });
  const [hit] = hits;
  if (hits.length !== 1 || !hit)
    throw new Error(`会话前缀 ${prefix} 匹配 ${hits.length} 个目录：${hits.join(', ')}`);
  return hit;
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

/** 解析单个压缩日志：区间、模型、耗时、token、产物与原文视图。 */
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
  const lastResult = body.filter((e) => e.type === 'tool/result').at(-1);
  const views: [HistoryArgs, string][] = [];
  for (const e of body) {
    if (e.type !== 'tool/call' || e.data?.name !== 'getHistory' || !e.data.callId) continue;
    const r = res.get(e.data.callId);
    if (r)
      views.push([JSON.parse(e.data.arguments || '{}') as HistoryArgs, textOf(r.message?.content)]);
  }
  return {
    id: head.id,
    parent: head.parentSession,
    range: rng ? [Number(rng[1]), Number(rng[2])] : undefined,
    model: model?.[1] ?? 'unknown',
    effort: model?.[2] ?? 'unknown',
    recompress: label.includes('重压缩'),
    wall_sec: times.length ? Math.round((Math.max(...times) - Math.min(...times)) / 100) / 10 : 0,
    requests: usage.length,
    tokens_in: usage.reduce((s, u) => s + (u.inputTokens ?? 0), 0),
    tokens_out: usage.reduce((s, u) => s + (u.outputTokens ?? 0), 0),
    product: textOf(lastResult?.data?.message?.content),
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
  const found = lastCall
    ? main.findIndex((e) => e.type === 'tool/call' && e.data?.callId === lastCall)
    : -1;
  const start = Math.max(found, 0);
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

/** 写 UTF-8 文本文件。 */
function write(dir: string, name: string, text: string): void {
  writeFileSync(join(dir, name), text, 'utf8');
}

/** 命令行入口。 */
function main(): void {
  const { values } = parseArgs({
    options: {
      session: { type: 'string' },
      range: { type: 'string' },
      out: { type: 'string' },
      seed: { type: 'string', default: '20261015' },
      'after-max': { type: 'string', default: '60000' },
    },
  });
  if (!values.session) throw new Error('缺少 --session');

  const mainDir = findMain(values.session);
  const wsDir = dirname(mainDir);
  const mainEv = loadLog(logFile(mainDir));
  const mainHead = mainEv[0];
  if (!mainHead?.id) throw new Error('主会话缺少会话头');
  const mainId = mainHead.id;
  const logs = readdirSync(wsDir)
    .filter((d) => d.startsWith('om-compaction-log-'))
    .map((d) => parseLog(loadLog(logFile(join(wsDir, d)))))
    .filter((x) => x.parent === mainId && x.range);
  const groups = new Map<string, CompactionLog[]>();
  for (const x of logs) {
    const k = x.range?.join('..') ?? '';
    groups.set(k, [...(groups.get(k) ?? []), x]);
  }
  if (!groups.size) throw new Error('该会话没有压缩日志');
  for (const [k, g] of groups) {
    console.log(
      `区间 [${k}]：${g.length} 个变体 ${g.map((x) => `${x.model}(${x.effort})`).join('、')}`,
    );
  }
  const latest = (g: CompactionLog[]) => Math.max(...g.map((x) => x.created));
  const rangeKey =
    values.range ??
    [...groups].reduce((a, b) =>
      b[1].length > a[1].length || (b[1].length === a[1].length && latest(b[1]) > latest(a[1]))
        ? b
        : a,
    )[0];
  const group = groups.get(rangeKey);
  if (!group) throw new Error(`区间 [${rangeKey}] 无压缩日志`);
  const [lo, hi] = rangeKey.split('..').map(Number) as [number, number];

  const out =
    values.out ??
    join(mainHead.cwd ?? '.', '.session-snapshots', `eval-${mainId.slice(8, 16)}-${lo}-${hi}`);
  mkdirSync(out, { recursive: true });
  const source = pickSource(group, lo, hi);
  write(out, 'source.xml', source);

  const key: Record<string, BlindEntry> = {};
  shuffle(group, Number(values.seed)).forEach((x, i) => {
    const v = `V${i + 1}`;
    write(out, `${v}.xml`, blindProduct(x.product));
    const { id, model, effort, recompress, wall_sec, requests, tokens_in, tokens_out } = x;
    key[v] = { id, model, effort, recompress, wall_sec, requests, tokens_in, tokens_out };
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
