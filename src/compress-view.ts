/**
 * 压缩视图：把被压缩区间投影为统一的条目序列（ViewEntry）。
 * 观察视图由完整消息原文构建（buildObserveView），反思视图由已有 <history> 块内条目构建
 * （buildReflectView）；getHistory 查看、compressHistory 区间校验与最终 <history> 块构建
 * 共用同一套条目。导出 ViewEntry / CompressionView / buildObserveView / buildReflectView /
 * renderEntriesXml / entryToElement / historyInner / toolCallNameOf。
 */

import type { Document, Element } from '@xmldom/xmldom';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { HISTORY_TAG } from './constants.ts';
import { indexCompleteMessages, renderCompleteMessage } from './log-index.ts';
import type { CompleteMessage, Session } from './types.ts';

/**
 * 视图条目：压缩区间内一条可定位的内容单位。
 * - user / sys 条目不可压缩（compressHistory 覆盖时报错），构建最终块时原样保留
 * - assistant 条目可压缩（观察视图为模型文本或工具调用原文，反思视图为块内摘要）
 * - reasoning 条目仅作参考，不进最终产物
 * - lo/hi 缺失的 assistant 条目为不可定位的历史遗留块（整块无法解析时降级保留）
 */
export type ViewEntry = {
  /** 条目类别。 */
  kind: 'user' | 'sys' | 'assistant' | 'reasoning';
  /** 覆盖区间下界（完整消息 index；reasoning 与历史遗留条目无）。 */
  lo?: number;
  /** 覆盖区间上界（单条 = lo；reasoning 与历史遗留条目无）。 */
  hi?: number;
  /** 条目文本（sys 为空串；user 为文本块原文；assistant 为原文或摘要）。 */
  text: string;
  /** user 条目的非文本块注释（图片附件元信息等，渲染为 XML 注释）。 */
  notes?: string[];
  /** sys 条目的 source.kind。 */
  sysKind?: string;
  /** 观察视图 toolcall 条目的工具名（skill 判定用）。 */
  toolName?: string;
  /** 所属压缩块 seq（反思视图；块整体展开以此分组）。 */
  blockSeq?: number;
};

/** 压缩视图：条目序列 + 要求区间（getHistory / compressHistory 的 index 合法范围）。 */
export type CompressionView = {
  /** 条目序列（按 index 顺序；reasoning 位于其所属 assistant 条目之前）。 */
  entries: ViewEntry[];
  /** 要求区间首 index（无任何可定位条目时 undefined）。 */
  minIndex?: number;
  /** 要求区间尾 index（无任何可定位条目时 undefined）。 */
  maxIndex?: number;
};

/** 静默 DOMParser：非致命解析问题不刷 console，fatalError 仍抛 ParseError、解析语义不变。 */
function newQuietParser(): DOMParser {
  return new DOMParser({ onError: () => {} });
}

/**
 * 提取用户消息条目的文本与注释（文本块拼接为原文；图片/其他块降级为注释文本，
 * 渲染时输出为 XML 注释）。无任何内容返回 null（该 index 在视图中不占条目）。
 */
function userEntryParts(
  session: Session,
  cm: CompleteMessage,
): { text: string; notes: string[] } | null {
  const seq = cm.seqs[0];
  const event = seq === undefined ? undefined : session.events[seq];
  const message = event ? session.deriveEventMessage(event) : null;
  if (!message || !Array.isArray(message.content)) return null;
  const texts: string[] = [];
  const notes: string[] = [];
  for (const block of message.content) {
    if (block.type === 'text') {
      texts.push(String(block.text));
    } else if (block.type === 'image') {
      const ref = block.attachment as
        | { name?: string; mediaType?: string; width?: number; height?: number; bytes?: number }
        | undefined;
      const name = ref?.name ? `：${ref.name}` : '';
      const meta = ref
        ? `（${String(ref.mediaType ?? '')} ${String(ref.width ?? '')}×${String(ref.height ?? '')}，${String(ref.bytes ?? '')} bytes）`
        : '';
      notes.push(` 图片附件${name}${meta} `);
    } else {
      notes.push(` ${String(block.type)} 块 `);
    }
  }
  if (texts.length === 0 && notes.length === 0) return null;
  return { text: texts.join('\n'), notes };
}

/**
 * 提取 toolcall 完整消息的工具名（按 callId 在所属 assistant 消息中定位 tool-call 块）。
 * 找不到返回 undefined。
 */
export function toolCallNameOf(session: Session, cm: CompleteMessage): string | undefined {
  if (cm.type !== 'toolcall') return undefined;
  const seq = cm.seqs[0];
  const event = seq === undefined ? undefined : session.events[seq];
  if (event?.type !== 'assistant/message') return undefined;
  const message = event.data.message;
  if (!message || !Array.isArray(message.content)) return undefined;
  for (const block of message.content) {
    if (block.type === 'tool-call' && String(block.id ?? '') === (cm.callId ?? '')) {
      return String(block.name ?? '');
    }
  }
  return undefined;
}

/**
 * 观察视图：被压缩区间（表层 seq 集合）内的完整消息投影为条目——
 * user → 原文（图片等非文本块为注释）、sys → 空条目、assistant/toolcall → 原文渲染，
 * reasoning 作为参考条目置于其所属 assistant 条目之前（每条 assistant 消息输出一次）。
 * 要求区间为区间内完整消息的首尾 index。
 */
export function buildObserveView(session: Session, seqs: readonly number[]): CompressionView {
  const shadowed = new Set(seqs);
  const reasoningBySeq = new Map<number, string[]>();
  for (const seq of seqs) {
    const event = session.events[seq];
    if (event?.type !== 'assistant/message') continue;
    const message = event.data.message;
    if (!message || !Array.isArray(message.content)) continue;
    const reasonings: string[] = [];
    for (const block of message.content) {
      if (block.type === 'reasoning' && typeof block.text === 'string') reasonings.push(block.text);
    }
    if (reasonings.length > 0) reasoningBySeq.set(seq, reasonings);
  }
  const entries: ViewEntry[] = [];
  const emittedReasoning = new Set<number>();
  for (const cm of indexCompleteMessages(session)) {
    if (!cm.seqs.every((seq) => shadowed.has(seq))) continue;
    if (cm.type === 'sys') {
      entries.push({
        kind: 'sys',
        lo: cm.index,
        hi: cm.index,
        text: '',
        ...(cm.kind === undefined ? {} : { sysKind: cm.kind }),
      });
      continue;
    }
    if (cm.type === 'user') {
      const parts = userEntryParts(session, cm);
      if (parts === null) continue;
      entries.push({
        kind: 'user',
        lo: cm.index,
        hi: cm.index,
        text: parts.text,
        ...(parts.notes.length === 0 ? {} : { notes: parts.notes }),
      });
      continue;
    }
    // assistant / toolcall 条目：先输出所属 assistant 消息的 reasoning（每条消息一次）
    const callSeq = cm.seqs[0];
    const reasonings = callSeq === undefined ? undefined : reasoningBySeq.get(callSeq);
    if (callSeq !== undefined && reasonings !== undefined && !emittedReasoning.has(callSeq)) {
      emittedReasoning.add(callSeq);
      for (const text of reasonings) {
        entries.push({ kind: 'reasoning', lo: cm.index, hi: cm.index, text });
      }
    }
    const text = renderCompleteMessage(session, cm);
    if (text.trim() === '') continue;
    const toolName = cm.type === 'toolcall' ? toolCallNameOf(session, cm) : undefined;
    entries.push({
      kind: 'assistant',
      lo: cm.index,
      hi: cm.index,
      text,
      ...(toolName === undefined ? {} : { toolName }),
    });
  }
  return { entries, ...viewBounds(entries) };
}

/** 提取视图要求区间：全部可定位条目的最小 lo 与最大 hi（无可定位条目时均 undefined）。 */
function viewBounds(entries: ViewEntry[]): { minIndex?: number; maxIndex?: number } {
  let minIndex: number | undefined;
  let maxIndex: number | undefined;
  for (const entry of entries) {
    if (entry.lo === undefined || entry.hi === undefined) continue;
    if (minIndex === undefined || entry.lo < minIndex) minIndex = entry.lo;
    if (maxIndex === undefined || entry.hi > maxIndex) maxIndex = entry.hi;
  }
  return {
    ...(minIndex === undefined ? {} : { minIndex }),
    ...(maxIndex === undefined ? {} : { maxIndex }),
  };
}

/** 提取 <history> 块的内文（去开/闭标签；非块文本原样返回）。 */
export function historyInner(text: string): string {
  const closeTag = `</${HISTORY_TAG}>`;
  const close = text.lastIndexOf(closeTag);
  if (close === -1) return text;
  const open = text.indexOf(`<${HISTORY_TAG}`);
  if (open === -1) return text;
  const gt = text.indexOf('>', open);
  if (gt === -1 || gt >= close) return text;
  return text.slice(gt + 1, close);
}

/** 读取元素整数属性（非负整数；缺失 / 非数字返回 undefined）。 */
function intAttr(el: Element, name: string): number | undefined {
  const raw = el.getAttribute(name);
  if (raw === null || raw === '') return undefined;
  if (!/^\d+$/.test(raw)) return undefined;
  return Number(raw);
}

/**
 * 解析一个已有 <history> 块的内条目（反思视图）：user_message / sys / assistant
 * （index 单条或 start/end 区间）/ reasoning。整块无法解析或根非 <history> 时降级为
 * 单条不可定位的历史遗留条目（text 为块内文原文，构建最终块时原样保留）。
 */
function parseBlockEntries(blockText: string, blockSeq: number): ViewEntry[] {
  const opaque = (): ViewEntry[] => [
    { kind: 'assistant', text: historyInner(blockText), blockSeq },
  ];
  let doc: Document;
  try {
    doc = newQuietParser().parseFromString(blockText, 'text/xml');
  } catch {
    return opaque();
  }
  const root = doc.documentElement;
  if (!root || root.nodeName !== HISTORY_TAG) return opaque();
  const entries: ViewEntry[] = [];
  const children = root.childNodes;
  for (let i = 0; i < children.length; i += 1) {
    const node = children[i];
    if (node?.nodeType !== 1) continue;
    const el = node as unknown as Element;
    const text = el.textContent ?? '';
    if (el.nodeName === 'user_message') {
      const index = intAttr(el, 'index');
      if (index === undefined) continue;
      entries.push({ kind: 'user', lo: index, hi: index, text, blockSeq });
    } else if (el.nodeName === 'sys') {
      const index = intAttr(el, 'index');
      if (index === undefined) continue;
      const type = el.getAttribute('type');
      entries.push({
        kind: 'sys',
        lo: index,
        hi: index,
        text: '',
        ...(type === null ? {} : { sysKind: type }),
        blockSeq,
      });
    } else if (el.nodeName === 'assistant') {
      const index = intAttr(el, 'index');
      if (index !== undefined) {
        entries.push({ kind: 'assistant', lo: index, hi: index, text, blockSeq });
        continue;
      }
      const start = intAttr(el, 'start');
      const end = intAttr(el, 'end');
      if (start !== undefined && end !== undefined) {
        entries.push({ kind: 'assistant', lo: start, hi: end, text, blockSeq });
      }
      // 属性缺失的 assistant 条目跳过（防御：产物块创建时已校验属性）
    } else if (el.nodeName === 'reasoning') {
      entries.push({ kind: 'reasoning', text, blockSeq });
    }
  }
  if (entries.length === 0) return opaque();
  return entries;
}

/**
 * 反思视图：全部 <history> 块（historySection 收集，按表层顺序）的内条目投影为条目。
 * 要求区间为全部块内条目引用的最小 / 最大 index；块解析失败降级为不可定位遗留条目。
 */
export function buildReflectView(blocks: Array<{ text: string; seq: number }>): CompressionView {
  const entries: ViewEntry[] = [];
  for (const block of blocks) {
    entries.push(...parseBlockEntries(block.text, block.seq));
  }
  return { entries, ...viewBounds(entries) };
}

/**
 * 把一个视图条目构建为 XML 元素（文本经 DOM 文本节点自动转义；user 条目的注释
 * 输出为 XML 注释节点）。getHistory 输出与最终 <history> 块共用。
 */
export function entryToElement(doc: Document, entry: ViewEntry): Element {
  if (entry.kind === 'user') {
    const el = doc.createElement('user_message');
    if (entry.lo !== undefined) el.setAttribute('index', String(entry.lo));
    el.appendChild(doc.createTextNode(entry.text));
    for (const note of entry.notes ?? []) el.appendChild(doc.createComment(note));
    return el;
  }
  if (entry.kind === 'sys') {
    const el = doc.createElement('sys');
    el.setAttribute('type', entry.sysKind ?? '');
    if (entry.lo !== undefined) el.setAttribute('index', String(entry.lo));
    el.appendChild(doc.createTextNode(''));
    return el;
  }
  if (entry.kind === 'reasoning') {
    const el = doc.createElement('reasoning');
    el.appendChild(doc.createTextNode(entry.text));
    return el;
  }
  const el = doc.createElement('assistant');
  if (entry.lo !== undefined && entry.hi !== undefined && entry.lo === entry.hi) {
    el.setAttribute('index', String(entry.lo));
  } else if (entry.lo !== undefined && entry.hi !== undefined) {
    el.setAttribute('start', String(entry.lo));
    el.setAttribute('end', String(entry.hi));
  }
  el.appendChild(doc.createTextNode(entry.text));
  return el;
}

/**
 * 渲染条目序列为 XML 文本（无 <history> 包裹，条目逐行拼接）——getHistory 的输出形式。
 */
export function renderEntriesXml(entries: ViewEntry[]): string {
  if (entries.length === 0) return '';
  const doc = newQuietParser().parseFromString('<root />', 'text/xml');
  const serializer = new XMLSerializer();
  return entries
    .map((entry) => serializer.serializeToString(entryToElement(doc, entry)))
    .join('\n');
}
