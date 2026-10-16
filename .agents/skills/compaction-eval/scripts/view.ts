/**
 * 构建压缩输入视图：复现某次压缩的输入，或按完整消息区间复现当时插件看到的视图。
 *
 * 用法：node view.ts (--session <主会话 id 或前缀> | --zip <会话日志 zip>)
 *       [--compaction <id> | --range A..B] [--out view.json]
 * 无选区：列出会话已有压缩。有选区：写 view.json，供 compress.ts 读取。
 * 导出 toSession / listCompactions / rangeView / buildViewFile 与 ViewFile 类型。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  type SessionEvent as HostEvent,
  Session,
  type SessionHeader,
  SessionId,
} from '@deepseek-ai/dsh-session';
import { historyTextOf } from '../../../../src/compress.ts';
import { viewCharCount } from '../../../../src/compress-loop.ts';
import {
  buildObserveView,
  buildReflectView,
  type ViewEntry,
} from '../../../../src/compress-view.ts';
import { resolveConfig } from '../../../../src/config.ts';
import { indexCompleteMessages } from '../../../../src/log-index.ts';
import { compactionView, type ReplayView } from '../../../../src/recompress.ts';
import type {
  CompactionEndPayload,
  CompactionStartPayload,
  CompactionSummaryPayload,
} from '../../../../src/types.ts';
import { loadProfile } from './profile.ts';
import { loadBundle, type SessionEvent } from './session-source.ts';

/** view.json：压缩输入视图与来源。 */
export interface ViewFile {
  /** 主会话头，用于给压缩日志挂父会话与工作目录。 */
  header: SessionHeader;
  /** 视图来源：已有压缩或自定义区间。 */
  source: { compactionId: string } | { range: [number, number] };
  phase: ReplayView['phase'];
  view: ReplayView['view'];
  originalChars: number;
}

/** 会话中一次压缩的概要。 */
export interface CompactionBrief {
  id: string;
  phase: string;
  range: [number, number] | undefined;
  ok: boolean;
  error: string | undefined;
  model: string | undefined;
}

/**
 * 由会话日志重建会话；可截到某个 seq（含）为止，得到当时的表层。
 * 日志来自 DSH 落盘的 jsonl，首行为会话头、其后 seq 与下标一致；Session.create 会校验事件与头字段。
 */
export function toSession(events: SessionEvent[], lastSeq?: number): Session {
  const [head, ...body] = events;
  if (!head?.id) throw new Error('日志缺少会话头');
  const { type: _type, ...header } = head;
  const seed = lastSeq === undefined ? body : body.slice(0, lastSeq + 1);
  return Session.create(
    SessionId(head.id),
    seed as unknown as HostEvent[],
    header as unknown as SessionHeader,
  );
}

/** 列出会话已有压缩：阶段、区间、成败与模型。 */
export function listCompactions(session: Session): CompactionBrief[] {
  const byId = new Map<
    string,
    {
      start?: CompactionStartPayload;
      summary?: CompactionSummaryPayload;
      end?: CompactionEndPayload;
    }
  >();
  const slot = (id: string) => {
    const hit = byId.get(id) ?? {};
    byId.set(id, hit);
    return hit;
  };
  for (const e of session.snapshotEvents()) {
    if (e.type === 'compaction/start')
      slot(String(e.data.compactionId)).start = e.data as CompactionStartPayload;
    else if (e.type === 'compaction/summary') slot(String(e.data.compactionId)).summary = e.data;
    else if (e.type === 'compaction/end') slot(String(e.data.compactionId)).end = e.data;
  }
  return [...byId].map(([id, { start, summary, end }]) => {
    const replay = compactionView(session, id, false);
    const ok = summary !== undefined && end !== undefined && end.error === undefined;
    return {
      id,
      phase: start?.phase ?? ('error' in replay ? 'unknown' : replay.phase),
      range: 'error' in replay ? undefined : [replay.view.minIndex, replay.view.maxIndex],
      ok,
      error: end?.error === undefined ? undefined : String(end.error),
      model: summary === undefined ? undefined : `${summary.provider}/${summary.model}`,
    };
  });
}

/** 条目是否与区间相交；不可定位条目视为不相交。 */
function intersects(entry: ViewEntry, lo: number, hi: number): boolean {
  return entry.lo !== undefined && entry.hi !== undefined && entry.lo <= hi && entry.hi >= lo;
}

/** 取块条目中与区间相交的部分；reasoning 跟随其后第一条可定位条目取舍。 */
function blockEntriesIn(entries: ViewEntry[], lo: number, hi: number): ViewEntry[] {
  const out: ViewEntry[] = [];
  let pending: ViewEntry[] = [];
  for (const entry of entries) {
    if (entry.kind === 'reasoning') {
      pending.push(entry);
      continue;
    }
    if (intersects(entry, lo, hi)) out.push(...pending, entry);
    pending = [];
  }
  return out;
}

/**
 * 按完整消息区间 [lo, hi] 复现视图：日志截到 hi 的最后事件，取当时表层；
 * 已压缩部分取 <history> 块中与区间相交的条目，块外取原文。含块条目为反思，否则为观察。
 */
export function rangeView(
  events: SessionEvent[],
  lo: number,
  hi: number,
  skipReasoning: boolean,
): ReplayView | { error: string } {
  if (lo > hi) return { error: `区间起点 ${lo} 大于终点 ${hi}` };
  const full = toSession(events);
  const messages = indexCompleteMessages(full);
  const last = messages.find((cm) => cm.index === hi);
  if (last === undefined) return { error: `会话没有完整消息 ${hi}` };
  if (!messages.some((cm) => cm.index === lo)) return { error: `会话没有完整消息 ${lo}` };
  const session = toSession(events, Math.max(...last.seqs));

  const blockEntries: ViewEntry[] = [];
  const blockSeqs = new Set<number>();
  for (const seq of session.surface.nodes) {
    const text = historyTextOf(session.snapshotEvents()[seq]);
    if (text === undefined) continue;
    blockSeqs.add(seq);
    blockEntries.push(...buildReflectView([{ text, seq }], { skipReasoning }).entries);
  }
  const surface = new Set<number>(session.surface.nodes);
  const rawSeqs = indexCompleteMessages(session)
    .filter((cm) => cm.index >= lo && cm.index <= hi && cm.seqs.every((s) => surface.has(s)))
    .flatMap((cm) => cm.seqs)
    .filter((seq) => !blockSeqs.has(seq));
  // 同一 assistant 事件可拆出多条完整消息，按条目区间再筛一次
  const raw = buildObserveView(session, rawSeqs, { skipReasoning }).entries.filter((e) =>
    intersects(e, lo, hi),
  );
  const blocks = blockEntriesIn(blockEntries, lo, hi);
  const entries = [...blocks, ...raw];
  const located = entries.filter((e) => e.lo !== undefined && e.hi !== undefined);
  if (located.length === 0) return { error: `区间 [${lo}..${hi}] 在当时表层中没有可压缩条目` };
  const phase = blocks.length > 0 ? 'reflect' : 'observe';
  const view = {
    entries,
    minIndex: Math.min(...located.map((e) => e.lo ?? lo)),
    maxIndex: Math.max(...located.map((e) => e.hi ?? hi)),
  };
  // 原文字符按实际给模型的条目计，区间筛掉的同事件消息不计入
  return { phase, view, originalChars: viewCharCount(view) };
}

/** 解析 A..B 区间。 */
function parseRange(text: string): [number, number] {
  const m = /^(\d+)\.\.(\d+)$/.exec(text);
  if (!m) throw new Error(`--range 需为 A..B：${text}`);
  return [Number(m[1]), Number(m[2])];
}

/** 按选区构建 view.json 内容。 */
export function buildViewFile(
  events: SessionEvent[],
  select: { compactionId: string } | { range: [number, number] },
  skipReasoning = resolveConfig().compressSkipReasoning,
): ViewFile {
  const session = toSession(events);
  const replay =
    'compactionId' in select
      ? compactionView(session, select.compactionId, skipReasoning)
      : rangeView(events, select.range[0], select.range[1], skipReasoning);
  if ('error' in replay) throw new Error(replay.error);
  return { header: session.header, source: select, ...replay };
}

/** 命令行入口。 */
function main(): void {
  const { values } = parseArgs({
    options: {
      session: { type: 'string' },
      zip: { type: 'string' },
      compaction: { type: 'string' },
      range: { type: 'string' },
      out: { type: 'string' },
    },
  });
  const { main: events } = loadBundle(values);
  if (values.compaction === undefined && values.range === undefined) {
    for (const c of listCompactions(toSession(events))) {
      const range = c.range ? `[${c.range.join('..')}]` : '[?]';
      const state = c.ok ? '成功' : `失败 ${c.error ?? '未完成'}`;
      console.log(`${c.id} ${c.phase} ${range} ${state} ${c.model ?? ''}`.trim());
    }
    return;
  }
  if (values.compaction !== undefined && values.range !== undefined)
    throw new Error('--compaction 与 --range 只能选其一');
  if (!values.out) throw new Error('需指定 --out');
  const file = buildViewFile(
    events,
    values.compaction !== undefined
      ? { compactionId: values.compaction }
      : { range: parseRange(values.range ?? '') },
    resolveConfig(loadProfile().plugin).compressSkipReasoning,
  );
  const outFile = resolve(values.out);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(file, null, 1), 'utf8');
  console.log(
    `${file.phase} [${file.view.minIndex}..${file.view.maxIndex}] 条目 ${file.view.entries.length}，原文 ${file.originalChars} 字符 → ${values.out}`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
