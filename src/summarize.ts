/**
 * 摘要调用：共享压缩提示词、<history> 块渲染与输出校验、LLM 摘要执行。
 * 导出 buildHistoryPrompt / renderMessages / extractSummaryLog / parseHistoryEntries /
 * historyContinuity / runSummarySubagent 及相关类型与常量。
 * 摘要以新会话方式直连 ctx.llm.stream()：指令（共享提示词）作为 system、被压缩消息
 * （renderMessages 渲染为合法 <history> 块）作为 user 输入；输出经 extractSummaryLog
 * 定位与校验（首个 <history> 开标签到最后一个 </history>；整块 XML 非法时按条目标签
 * 模糊提取重建 / 无 reasoning / index 连续），失败按 maxAttempts 重试；每次尝试的
 * 结果或报错始终写入日志（成功 info / 失败 warn，失败原因说明具体问题而非解析器
 * 原始报错）；全部耗尽返回失败结果（携带最后一次尝试的实际报错）。最终失败
 * （含 signal 中止）时把每次尝试的完整提示词与模型原始输出经 compaction-log.ts
 * 原样落盘为诊断子会话，sessionId 随失败结果向上传播进主会话日志。每次请求前
 * 过全局限流等待门；token usage 归入主会话记录。
 */

import type { FinishReason, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { Document, Element } from '@xmldom/xmldom';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { recordCompactionFailure, type SummaryAttemptRecord } from './compaction-log.ts';
import {
  COMPACTION_ABORTED_ERROR,
  COMPLETE_MESSAGE_DEFINITION,
  HISTORY_TAG,
  HISTORY_TIP,
  PLUGIN_LABEL,
} from './constants.ts';
import { indexCompleteMessages, renderCompleteMessage } from './log-index.ts';
import { makeLogger } from './logger.ts';
import {
  gateRateLimit,
  isRateLimitError,
  noteRateLimit,
  RATE_LIMIT_WAIT_MS_DEFAULT,
} from './rate-limit.ts';
import type { Agent, CompleteMessage, Context, Session, TokenUsage, UserMessage } from './types.ts';
import { type RoutedTarget, uuid } from './utils.ts';

/**
 * 共享压缩提示词（观察/反思同一套）：定义 history 块（模型消息 + index 的表达形式）、
 * 完整消息定义、压缩要求、输出格式与数据源说明。
 */
export function buildHistoryPrompt(): string {
  const lines: string[] = [
    '压缩 <history> 消息记录。你应当输出**单个**合法的 <history> 块。',
    '',
    '【history 块定义】',
    '- <history> 是历史消息的记录块。',
    '- <user_message index="N">：用户消息条目。',
    '- <sys type="(kind)" index="N">：系统消息条目。',
    '- <reasoning>：模型的思考过程，仅作压缩参考，产物中不要出现。',
    '- <assistant index="N">：单条完整消息（模型输出文本，或 toolcall 及其 result）。',
    '- <assistant start="A" end="B">：多条连续完整消息聚合的模块（A/B 为模块首尾完整消息的 index）。',
    '',
    '【压缩要求】',
    '- <user_message> <sys> 条目从输入中逐条保留，不做任何处理。',
    '- <reasoning> 只作参考，输出产物中不包含 <reasoning> 块。',
    '- 将具有关联性的 <assistant> 消息按内在逻辑连贯性划分为连续模块，聚合为 <assistant start="" end=""> 块',
    '- 单条重要的完整消息以 <assistant index=""> 单独呈现',
    '- 压缩后的 <assistant> 块内，应当描述**行为逻辑**，强调关键的**结论、产出和任务**；涉及到的具体文件保留完整路径',
    '- 加载的 skill 属于**关键信息**：应当产出独立块且不过多省略。',
    '- 压缩后的消息，区间边界与输入的消息必须完全相同，内部 index/start/end 必须连续，相邻区间的左右界必须相邻，',
    '',
    '【摘要粒度】',
    '- 越往后越细：靠近末尾（最近）的完整消息保留更多细节（关键文件、改动与结论），开头（较早）的完整消息可适当从简。',
    '- 用户消息不受此约束：始终逐条保留原文，不做概括与省略。',
    '',
    '【输出格式】输出单个合法的 <history> 块，**不包含其他任何内容**：',
    `<${HISTORY_TAG}>`,
    '<user_message index="(index)">',
    '(user 消息原文)',
    '</user_message>',
    '<sys type="(kind)" index="(index)"></sys>',
    '<assistant start="(起始 index)" end="(结束 index)">',
    '(模块的目的、行为与结果摘要)',
    '</assistant>',
    '<assistant index="(index)">',
    '(单条完整消息的模块摘要)',
    '</assistant>',
    `</${HISTORY_TAG}>`,
    '',
    '【数据源】下方的 <history> 消息记录是本次要压缩的全部消息；压缩结果作为一个新的 <history> 块输出。',
  ];
  return lines.join('\n');
}

/**
 * 静默 DOMParser：非致命解析问题不再走 xmldom 默认的 console.error 输出
 * （模型输出非法 XML 时避免刷 console），fatalError 仍抛 ParseError、解析语义不变。
 */
function newQuietParser(): DOMParser {
  return new DOMParser({ onError: () => {} });
}

/** 渲染用户消息条目（DOM 元素）：文本块原样；图片/文件等非文本块以注释补充。 */
function renderUserEntry(doc: Document, session: Session, cm: CompleteMessage): Element | null {
  const seq = cm.seqs[0];
  const event = seq === undefined ? undefined : session.events[seq];
  const message = event ? session.deriveEventMessage(event) : null;
  if (!message || !Array.isArray(message.content)) return null;
  const el = doc.createElement('user_message');
  el.setAttribute('index', String(cm.index));
  let hasContent = false;
  for (const block of message.content) {
    if (block.type === 'text') {
      el.appendChild(doc.createTextNode(String(block.text)));
      hasContent = true;
    } else if (block.type === 'image') {
      const ref = block.attachment as
        | { name?: string; mediaType?: string; width?: number; height?: number; bytes?: number }
        | undefined;
      const name = ref?.name ? `：${ref.name}` : '';
      const meta = ref
        ? `（${String(ref.mediaType ?? '')} ${String(ref.width ?? '')}×${String(ref.height ?? '')}，${String(ref.bytes ?? '')} bytes）`
        : '';
      el.appendChild(doc.createComment(` 图片附件${name}${meta} `));
      hasContent = true;
    } else {
      el.appendChild(doc.createComment(` ${String(block.type)} 块 `));
      hasContent = true;
    }
  }
  if (!hasContent) return null;
  return el;
}

/**
 * 渲染完整消息记录（观察输入）：输出一个合法的 <history> 块——
 * user → <user_message>（文本原样、图片注释）、sys → <sys> 空块、assistant 的
 * reasoning → <reasoning>（参考条目）、assistant/toolcall → <assistant>（原样文本）。
 * 文本经 XML 序列化自动转义；仅渲染 seqs 全部落在给定集合内的完整消息。
 */
export function renderMessages(session: Session, seqs: readonly number[]): string {
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
  const emittedReasoning = new Set<number>();
  const doc = newQuietParser().parseFromString(`<${HISTORY_TAG} />`, 'text/xml');
  const entries: Element[] = [];
  for (const cm of indexCompleteMessages(session)) {
    if (!cm.seqs.every((seq) => shadowed.has(seq))) continue;
    if (cm.type === 'sys') {
      // 系统消息：空块（空文本节点保证序列化为 <sys ...></sys> 开闭形式）
      const sysEl = doc.createElement('sys');
      sysEl.setAttribute('type', cm.kind ?? '');
      sysEl.setAttribute('index', String(cm.index));
      sysEl.appendChild(doc.createTextNode(''));
      entries.push(sysEl);
      continue;
    }
    if (cm.type === 'user') {
      const rendered = renderUserEntry(doc, session, cm);
      if (rendered === null) continue;
      entries.push(rendered);
    } else {
      // assistant / toolcall 条目：先输出所属 assistant 消息的 reasoning（每条消息一次）
      const callSeq = cm.seqs[0];
      const reasonings = callSeq === undefined ? undefined : reasoningBySeq.get(callSeq);
      if (callSeq !== undefined && reasonings !== undefined && !emittedReasoning.has(callSeq)) {
        emittedReasoning.add(callSeq);
        for (const text of reasonings) {
          const re = doc.createElement('reasoning');
          re.appendChild(doc.createTextNode(text));
          entries.push(re);
        }
      }
      const text = renderCompleteMessage(session, cm);
      if (text.trim() === '') continue;
      const el = doc.createElement('assistant');
      el.setAttribute('index', String(cm.index));
      el.appendChild(doc.createTextNode(text));
      entries.push(el);
    }
  }
  const serializer = new XMLSerializer();
  return `<${HISTORY_TAG}>\n${entries.map((el) => serializer.serializeToString(el)).join('\n')}\n</${HISTORY_TAG}>`;
}

/** 摘要调用成功结果：文本 + 可选 token usage + 尝试次数。 */
export type SummarySuccess = {
  ok: true;
  text: string;
  usage?: TokenUsage;
  /** 成功时的尝试次数（1 起；载荷层换算为重试次数 = 该值 - 1）。 */
  attemptCount: number;
};

/** 摘要调用失败结果：最后一次尝试的实际报错/具体问题 + 是否因 signal 中止 + 诊断子会话 id。 */
export type SummaryFailure = {
  ok: false;
  /** 最后一次尝试的实际报错（异常消息）或未通过校验的具体问题说明。 */
  error: string;
  /** 因 signal 中止（含限流等待被中止）而放弃；此时 error 为 COMPACTION_ABORTED_ERROR。 */
  aborted: boolean;
  /** 诊断子会话 id（最终失败时每次尝试的完整提示词与模型原始输出落盘处；落盘失败时缺失）。 */
  diagnosticSessionId?: string;
};

/** 摘要调用结果（成功/失败二选一）。 */
export type SummaryOutcome = SummarySuccess | SummaryFailure;

/** 流收集器：提取文本输出 + usage + finish（不依赖宿主 BlockAssembler）。 */
class StreamCollector {
  private textBuf = '';
  private _usage: TokenUsage | undefined;
  private _finish: FinishReason | undefined;

  /** 喂入一个流 chunk（仅消费文本/usage/finish，其余忽略）。 */
  push(chunk: StreamChunk): void {
    switch (chunk.type) {
      case 'text-delta':
        this.textBuf += chunk.text;
        break;
      case 'usage':
        this._usage = chunk.usage;
        break;
      case 'finish':
        this._finish = chunk.reason;
        break;
      default:
        break;
    }
  }

  /** 拼接后的文本输出。 */
  get text(): string {
    return this.textBuf;
  }

  /** 摘要 token usage（无则 undefined）。 */
  get usage(): TokenUsage | undefined {
    return this._usage;
  }

  /** 终止原因（流未给出 finish 时视为 stop）。 */
  get finish(): FinishReason {
    return this._finish ?? { kind: 'stop' };
  }
}

/** 构造插件自产 user 消息（摘要调用的输入消息；id 为品牌类型 MessageId）。 */
function makePluginUserMessage(text: string): UserMessage {
  return {
    id: uuid() as unknown as UserMessage['id'],
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: PLUGIN_LABEL },
  } as unknown as UserMessage;
}

/**
 * 构建摘要请求选项：指令作为 system，渲染输入作为唯一的 user 消息，
 * 不沿用主会话请求前缀（前缀复用需模型自行计数，导致索引异常）。
 */
function buildSummaryOptions(
  session: Session,
  instruction: string,
  contextText: string | undefined,
  maxTokens: number | undefined,
  target: RoutedTarget,
  signal: AbortSignal | undefined,
): GenerateOptions {
  return {
    provider: target.provider,
    model: target.model,
    ...(maxTokens === undefined ? {} : { maxTokens }),
    sessionId: session.id,
    purpose: 'compaction' as const,
    ...(signal === undefined ? {} : { signal }),
    system: instruction,
    messages: [makePluginUserMessage(contextText ?? '')],
  };
}

/** 日志最小有效长度：<history> 中间内容小于该长度视为不合法。 */
export const MIN_HISTORY_LENGTH = 10;

/** 产出日志后插入首个 <history> 后的格式说明（XML 注释，完整消息定义 + 条目标签语义）。 */
export const HISTORY_FORMAT_NOTE = `<!-- 完整消息：${COMPLETE_MESSAGE_DEFINITION} <TAG index="N">表示单条完整消息，<TAG start="A" end="B"> 表示连续模块，start/end 是首尾完整消息的 index；<sys type="KIND" index="N"> 表示被压缩的系统消息，块中为空 -->`;

/**
 * 剥离 <history> 块内文块首的格式说明注释（HISTORY_FORMAT_NOTE 整体精确匹配，仅块首
 * 一处）；正文条目内出现的同名注释串不动。非块首或不匹配时原样返回。
 */
export function stripLeadingFormatNote(inner: string): string {
  if (!inner.startsWith(HISTORY_FORMAT_NOTE)) return inner;
  return inner.slice(HISTORY_FORMAT_NOTE.length).replace(/^\s+/, '');
}

/** history 块内条目（单条 index 或模块 start/end）。 */
export type HistoryEntryRange = {
  kind: 'user' | 'assistant' | 'sys';
  index?: number;
  start?: number;
  end?: number;
};

/** 解析后的 history 块结构（条目 + 是否含 reasoning）。 */
type ParsedHistoryBlock = {
  entries: HistoryEntryRange[];
  hasReasoning: boolean;
};

/** 读取元素整数属性（非负整数；缺失 / 非数字返回 undefined）。 */
function intAttr(el: Element, name: string): number | undefined {
  const raw = el.getAttribute(name);
  if (raw === null || raw === '') return undefined;
  if (!/^\d+$/.test(raw)) return undefined;
  return Number(raw);
}

/**
 * 用 XML 解析器解析一个 <history> 块（结构合法性校验）：
 * 非法 XML / 根非 <history> / 顶层出现未定义元素 / 条目属性缺失或非法 → null；
 * 出现 <reasoning> 元素时标记 hasReasoning（产物不允许）。
 */
function parseHistoryBlock(xml: string): ParsedHistoryBlock | null {
  let doc: Document;
  try {
    doc = newQuietParser().parseFromString(xml, 'text/xml');
  } catch {
    return null;
  }
  const root = doc.documentElement;
  if (!root || root.nodeName !== HISTORY_TAG) return null;
  const entries: HistoryEntryRange[] = [];
  let hasReasoning = false;
  const children = root.childNodes;
  for (let i = 0; i < children.length; i += 1) {
    const node = children[i];
    if (node?.nodeType !== 1) continue;
    const el = node as unknown as Element;
    const tag = el.nodeName;
    if (tag === 'reasoning') {
      hasReasoning = true;
      continue;
    }
    if (tag === 'user_message') {
      const index = intAttr(el, 'index');
      if (index === undefined) return null;
      entries.push({ kind: 'user', index });
    } else if (tag === 'sys') {
      // 系统消息条目：必须带 index（type 为 source.kind，不参与连续性校验）
      const index = intAttr(el, 'index');
      if (index === undefined) return null;
      entries.push({ kind: 'sys', index });
    } else if (tag === 'assistant') {
      const index = intAttr(el, 'index');
      if (index !== undefined) {
        entries.push({ kind: 'assistant', index });
      } else {
        const start = intAttr(el, 'start');
        const end = intAttr(el, 'end');
        if (start === undefined || end === undefined) return null;
        entries.push({ kind: 'assistant', start, end });
      }
    } else {
      return null;
    }
  }
  return { entries, hasReasoning };
}

/**
 * 解析文本中全部 <history> 块内的条目（逐块解析提取，兼容多块拼接文本）。
 * 非法块跳过；仅提取不校验顺序（连续性由 historyContinuity 校验）。
 */
export function parseHistoryEntries(text: string): HistoryEntryRange[] {
  const out: HistoryEntryRange[] = [];
  const blockRe = /<history[\s\S]*?<\/history>/g;
  for (const m of text.matchAll(blockRe)) {
    const parsed = parseHistoryBlock(m[0]);
    if (parsed === null) continue;
    out.push(...parsed.entries);
  }
  return out;
}
/**
 * 校验条目 index/start/end 连续性：每条给出覆盖区间，按出现顺序相邻条目必须首尾相接，
 * 返回整体覆盖区间；空条目 / 非法范围 / 跳号、重叠或乱序 → 返回 null。
 */
export function historyContinuity(
  entries: HistoryEntryRange[],
): { start: number; end: number } | null {
  if (entries.length === 0) return null;
  const ranges: Array<{ lo: number; hi: number }> = [];
  for (const e of entries) {
    const lo = e.kind === 'assistant' && e.start !== undefined ? e.start : (e.index ?? 0);
    const hi = e.kind === 'assistant' && e.end !== undefined ? e.end : (e.index ?? 0);
    if (lo > hi) return null;
    ranges.push({ lo, hi });
  }
  for (let i = 1; i < ranges.length; i += 1) {
    const prev = ranges[i - 1];
    const curr = ranges[i];
    if (prev === undefined || curr === undefined) return null;
    if (curr.lo !== prev.hi + 1) return null;
  }
  const first = ranges[0];
  const last = ranges[ranges.length - 1];
  if (first === undefined || last === undefined) return null;
  return { start: first.lo, end: last.hi };
}

/** 校验期望覆盖区间（外部传入；仅校验提供的字段，缺省字段跳过）。 */
export type SummaryValidationRange = { start?: number; end?: number };

/** <history> 开标签（允许携带属性）：模糊定位输出中日志块起点。 */
const HISTORY_OPEN_TAG_RE = /<history(\s[^>]*)?>/;

/** history 块内条目标签的 token 正则（开 / 闭 / 自闭合）：模糊提取按标签逐个扫描配对。 */
const HISTORY_ENTRY_TOKEN_RE = /<(\/)?(user_message|sys|assistant|reasoning)\b([^>]*?)(\/)?>/g;

/** 解析标签属性串为键值对（支持双引号 / 单引号 / 无引号取值；非法片段忽略）。 */
function parseTagAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of raw.matchAll(/([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    const key = m[1] ?? '';
    const value = m[3] ?? m[4] ?? m[5] ?? '';
    if (key !== '') attrs[key] = value;
  }
  return attrs;
}

/**
 * 解码 XML 预定义实体（&amp; 最后解码，避免 &amp;lt; 之类被二次解码）。
 * 模糊提取的条目文本解码后经 XML 序列化重新转义，已有转义形式不发生二次转义。
 */
function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * 模糊重建 <history> 块（xmldom 原生无模糊匹配，按条目标签做字符串级扫描配对）：
 * 依次提取 user_message / sys / assistant / reasoning 条目——开闭标签就近配对、
 * 自闭合直接成条、未闭合条目以文本末尾收口；未知元素与其间杂文忽略；条目文本
 * 解码后重新序列化为合法 XML。扫描不到任何条目返回 null。
 */
function rebuildHistoryBlock(inner: string): string | null {
  type OpenEntry = { tag: string; attrs: Record<string, string>; contentFrom: number };
  type RawEntry = { tag: string; attrs: Record<string, string>; content: string };
  const entries: RawEntry[] = [];
  const stack: OpenEntry[] = [];
  for (const m of inner.matchAll(HISTORY_ENTRY_TOKEN_RE)) {
    const tag = m[2] ?? '';
    if (m[1] === '/') {
      // 闭标签：与栈顶最近的同标签开标签配对成条
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        const open = stack[i];
        if (open?.tag === tag) {
          entries.push({ tag, attrs: open.attrs, content: inner.slice(open.contentFrom, m.index) });
          stack.splice(i, 1);
          break;
        }
      }
    } else if (m[4] === '/') {
      // 自闭合标签：空条目
      entries.push({ tag, attrs: parseTagAttrs(m[3] ?? ''), content: '' });
    } else {
      stack.push({ tag, attrs: parseTagAttrs(m[3] ?? ''), contentFrom: m.index + m[0].length });
    }
  }
  for (const open of stack) {
    entries.push({ tag: open.tag, attrs: open.attrs, content: inner.slice(open.contentFrom) });
  }
  if (entries.length === 0) return null;
  const doc = newQuietParser().parseFromString(`<${HISTORY_TAG} />`, 'text/xml');
  const root = doc.documentElement;
  if (!root) return null;
  for (const e of entries) {
    const el = doc.createElement(e.tag);
    for (const [key, value] of Object.entries(e.attrs))
      el.setAttribute(key, decodeXmlEntities(value));
    el.appendChild(doc.createTextNode(decodeXmlEntities(e.content)));
    root.appendChild(el);
  }
  return new XMLSerializer().serializeToString(root);
}

/**
 * 从 AI 摘要输出中提取合法日志（不信任 AI 的总结结果）：
 * 取首个 <history> 开标签（允许带属性）到最后一个 </history> 切为候选块，
 * 找不到或内容过短返回具体原因；候选块经 XML 结构校验，整块非法时按条目模糊
 * 提取重建为合法块（不要求模型输出整体合法 XML）；随后统一校验：无 reasoning、
 * index 连续且与 expected 覆盖区间一致；通过后统一改写为带 tip 属性的开标签
 * 并在块顶插入格式说明注释。所有失败原因均为说明性描述，不携带解析器原始报错。
 */
export function extractSummaryDetailed(
  raw: string,
  expected?: SummaryValidationRange,
): { log: string } | { error: string } {
  const closeTag = `</${HISTORY_TAG}>`;
  const openMatch = HISTORY_OPEN_TAG_RE.exec(raw);
  const open = openMatch?.index ?? -1;
  const close = raw.lastIndexOf(closeTag);
  if (openMatch === null || close === -1 || close < open) {
    return {
      error: '输出中找不到完整的 <history> 块（缺少 <history> 开标签或 </history> 闭标签）',
    };
  }
  const inner = raw.slice(open + openMatch[0].length, close);
  if (inner.trim().length < MIN_HISTORY_LENGTH) {
    return { error: '输出中 <history> 块内容过短（少于 10 字符）' };
  }
  const block = raw.slice(open, close + closeTag.length);
  const candidate = parseHistoryBlock(block) === null ? rebuildHistoryBlock(inner) : block;
  if (candidate === null) {
    return {
      error: '输出不是合法的 <history> 块（XML 结构非法，按条目模糊提取也未找到有效条目）',
    };
  }
  const parsed = parseHistoryBlock(candidate);
  if (parsed === null) {
    return { error: '输出不是合法的 <history> 块（条目结构非法：属性缺失或包含未定义元素）' };
  }
  if (parsed.hasReasoning) {
    return { error: '输出包含 <reasoning> 条目（产物不允许携带思考过程）' };
  }
  const span = historyContinuity(parsed.entries);
  if (span === null) {
    return { error: '输出条目 index/start/end 不连续（跳号、重叠或乱序）' };
  }
  if (expected?.start !== undefined && span.start !== expected.start) {
    return { error: `输出覆盖区间从 ${span.start} 开始，与期望起始 ${expected.start} 不一致` };
  }
  if (expected?.end !== undefined && span.end !== expected.end) {
    return { error: `输出覆盖区间止于 ${span.end}，与期望结束 ${expected.end} 不一致` };
  }
  const candidateInner = candidate
    .slice(candidate.indexOf('>') + 1, candidate.length - closeTag.length)
    .trim();
  return {
    log: `<${HISTORY_TAG} tip="${HISTORY_TIP}">\n${HISTORY_FORMAT_NOTE}\n${candidateInner}\n</${HISTORY_TAG}>`,
  };
}

/**
 * extractSummaryDetailed 的简便形式：提取成功返回合法日志块，失败返回 null
 * （具体失败原因经 extractSummaryDetailed 获取）。
 */
export function extractSummaryLog(raw: string, expected?: SummaryValidationRange): string | null {
  const extracted = extractSummaryDetailed(raw, expected);
  return 'log' in extracted ? extracted.log : null;
}

/** 摘要调用总尝试次数兜底（无 options.maxAttempts 时；实际由 config.compressRetryCount + 1 传入）。 */
export const SUMMARY_DEFAULT_MAX_ATTEMPTS = 11;

/** 尝试失败的简短记录（供重试日志与最终失败日志使用）：error=实际报错，reason=校验/完成度问题的具体说明。 */
type AttemptFailure = { error?: string; reason?: string };

/**
 * 直连 LLM 执行一次摘要（观察或反思），返回文本与可选 token usage。
 * 失败（抛异常 / 空输出 / 非 stop 结束 / 校验不通过）均记录日志并重试，每次尝试的
 * 结果或报错始终写入日志（成功 info / 失败 warn，不受 debug 影响）；全部尝试耗尽
 * 返回失败结果（携带最后一次尝试的实际报错/具体问题）。最终失败（耗尽或 signal
 * 中止）时把每次尝试的完整提示词与模型原始输出原样落盘为诊断子会话（phase 标注
 * 观察或反思），诊断子会话 id 随失败结果返回。signal 中止（含限流等待被中止）
 * 立即放弃并标记 aborted。每次请求发出前先过全局限流等待门。
 */
export async function runSummarySubagent(
  ctx: Context,
  agent: Agent,
  instruction: string,
  contextText: string | undefined,
  maxTokens: number | undefined,
  target: RoutedTarget,
  debug: boolean,
  signal?: AbortSignal,
  options?: {
    maxAttempts?: number;
    expected?: SummaryValidationRange;
    rateLimitWaitMs?: number;
    /** 压缩 pass（诊断子会话 label 标注观察/反思；未提供时 label 回落「压缩」）。 */
    phase?: 'observe' | 'reflect';
  },
): Promise<SummaryOutcome> {
  const session = agent.session;
  const logger = makeLogger(ctx, debug);
  const maxAttempts = options?.maxAttempts ?? SUMMARY_DEFAULT_MAX_ATTEMPTS;
  let lastFailure: AttemptFailure = {};
  /** 逐尝试的完整记录（提示词 + 原始输出原样收集，仅最终失败时落盘）。 */
  const attempts: SummaryAttemptRecord[] = [];
  /** 最终失败的统一出口：落盘诊断子会话并携带其 id 返回。 */
  const finishFailure = async (error: string, aborted: boolean): Promise<SummaryFailure> => {
    const diagnosticSessionId = await recordCompactionFailure(ctx, session, {
      phase: options?.phase,
      target,
      attempts,
      debug,
    });
    return {
      ok: false,
      error,
      aborted,
      ...(diagnosticSessionId === undefined ? {} : { diagnosticSessionId }),
    };
  };
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal?.aborted) {
      logger.warn(
        `摘要调用中止（第 ${attempt}/${maxAttempts} 次尝试前 signal 已中止），放弃本次压缩`,
      );
      return await finishFailure(COMPACTION_ABORTED_ERROR, true);
    }
    const rateLimitWaitMs = options?.rateLimitWaitMs ?? RATE_LIMIT_WAIT_MS_DEFAULT;
    const gated = await gateRateLimit(rateLimitWaitMs, signal);
    if (!gated) {
      logger.warn(
        `摘要调用中止（第 ${attempt}/${maxAttempts} 次尝试前限流等待被 signal 中止），放弃本次压缩`,
      );
      return await finishFailure(COMPACTION_ABORTED_ERROR, true);
    }
    logger.step(
      `摘要调用开始（第 ${attempt}/${maxAttempts} 次，provider ${target.provider}，model ${target.model}，maxTokens ${
        maxTokens === undefined ? '未设置' : String(maxTokens)
      }）`,
    );
    // 实际提示词全文（system 指令 + 渲染输入，模型实际看到的完整内容）；流中途
    // 抛异常时 collector 持有已收集的部分输出，两者均原样进入诊断记录
    const prompt = `${instruction}\n\n${contextText ?? ''}`;
    const collector = new StreamCollector();
    let streamCompleted = false;
    try {
      const requestOptions = buildSummaryOptions(
        session,
        instruction,
        contextText,
        maxTokens,
        target,
        signal,
      );
      for await (const chunk of ctx.llm.stream(requestOptions)) collector.push(chunk);
      streamCompleted = true;
      attempts.push({ prompt, rawOutput: collector.text });
      const extracted = extractSummaryDetailed(collector.text, options?.expected);
      const finish = collector.finish;
      if (finish.kind !== 'stop') {
        lastFailure = { reason: `摘要流以 ${String(finish.kind)} 结束（非正常完成）` };
        logger.warn(
          `摘要未完成（第 ${attempt}/${maxAttempts} 次，${lastFailure.reason}）` +
            (attempt < maxAttempts ? '，将重试' : '，重试耗尽，放弃本次压缩'),
        );
        continue;
      }
      if ('error' in extracted) {
        lastFailure = { reason: extracted.error };
        logger.warn(
          `摘要输出未通过校验（第 ${attempt}/${maxAttempts} 次，${extracted.error}）` +
            (attempt < maxAttempts ? '，将重试' : '，重试耗尽，放弃本次压缩'),
        );
        continue;
      }
      const text = extracted.log;
      const usage = collector.usage;
      logger.info(
        `摘要调用成功（第 ${attempt}/${maxAttempts} 次，输出 ${text.length} 字符` +
          (usage === undefined
            ? ''
            : `，input ${String(usage.inputTokens ?? '?')} / output ${String(usage.outputTokens ?? '?')} tokens`) +
          '）',
      );
      return { ok: true, text, attemptCount: attempt, ...(usage === undefined ? {} : { usage }) };
    } catch (error) {
      if (!streamCompleted) attempts.push({ prompt, rawOutput: collector.text });
      const message = error instanceof Error ? error.message : String(error);
      if (isRateLimitError(message)) {
        noteRateLimit();
        logger.warn(
          `摘要调用触发限流（429，第 ${attempt}/${maxAttempts} 次），下一次请求前至少等待 ${rateLimitWaitMs}ms`,
        );
      }
      lastFailure = { error: message };
      logger.warn(
        `摘要调用失败（第 ${attempt}/${maxAttempts} 次，${message}）` +
          (attempt < maxAttempts ? '，将重试' : '，重试耗尽，放弃本次压缩'),
      );
    }
  }
  const lastError = lastFailure.error ?? lastFailure.reason ?? '未知原因';
  logger.warn(
    `摘要调用最终失败（已尝试 ${maxAttempts} 次，最后错误：${lastError}），拒绝放行本轮 step`,
  );
  return await finishFailure(lastError, false);
}
