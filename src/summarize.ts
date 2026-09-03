/**
 * 摘要调用：共享压缩提示词、<history> 块渲染与输出校验、LLM 摘要执行。
 * 导出 buildHistoryPrompt / renderMessages / extractSummaryLog / parseHistoryEntries /
 * historyContinuity / runSummarySubagent 及相关类型与常量。
 * 摘要以新会话方式直连 ctx.llm.stream()：指令（共享提示词）作为 system、被压缩消息
 * （renderMessages 渲染为合法 <history> 块）作为 user 输入；输出经 extractSummaryLog
 * 定位与校验（首个 <history> 开标签到最后一个 </history>；整块 XML 非法时按条目标签
 * 模糊提取重建 / 无 reasoning / index 连续），失败按 maxAttempts 重试；每次请求前
 * 过全局限流等待门；token usage 归入主会话记录。
 */

import type { FinishReason, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { Document, Element } from '@xmldom/xmldom';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import {
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
 * 完整消息定义、压缩要求（完整保留用户/系统消息、reasoning 仅参考、关联 assistant
 * 合并为模块、index 连续）、输出格式与数据源说明。
 */
export function buildHistoryPrompt(): string {
  const lines: string[] = [
    '把下方的 <history> 消息记录压缩为一份更紧凑的 <history> 压缩日志。不用工具、不展示思考、不输出多余文字。',
    '',
    '【history 块定义】',
    '- <history> 是历史消息的记录块：输入与输出都是合法的 <history> 块，块内条目是「模型消息 + index」的表达形式。',
    `- 完整消息：${COMPLETE_MESSAGE_DEFINITION}`,
    '- <user_message index="N">：用户消息条目（N 为该条完整消息的 index；文本原样，图片/文件等以注释补充）。',
    '- <sys type="(kind)" index="N">：系统消息条目（user_message 中非 kind:user 的部分，如宿主注入的上下文），块中为空，内容不进入压缩输入。',
    '- <reasoning>：模型的思考过程，仅作压缩参考，产物中不要出现。',
    '- <assistant index="N">：单条完整消息（模型输出文本，或 toolcall 及其 result）。',
    '- <assistant start="A" end="B">：多条连续完整消息聚合的模块（A/B 为模块首尾完整消息的 index）。',
    '',
    '【压缩要求】',
    '- 完整保留用户消息：<user_message> 条目逐条保留原文，不概括、不省略。',
    '- 完整保留系统消息：<sys> 条目逐条原样保留（type 与 index 不变），块中为空，不概括、不省略、不填充内容。',
    '- <reasoning> 只作参考，输出产物中不包含 <reasoning> 块。',
    '- 将具有关联性的 <assistant> 消息按内在逻辑连贯性划分为连续模块，聚合为 <assistant start="" end=""> 块：块内描述模块的目的、行为与结果；涉及的具体文件保留在模块内容中，多个前缀相同的路径合并简写。',
    '- 单条重要的完整消息以 <assistant index=""> 单独呈现，内容不受限制。',
    '- 条目按 index 顺序覆盖本次压缩的全部完整消息：index/start/end 必须连续（区间内 index 连续、相邻条目相接），不跳号、不重叠、不遗漏。',
    '- 条目内容为合法 XML 文本：特殊字符保持转义形式（如 & → &amp;、< → &lt;），用户消息原文的转义形式原样保留，不要反转义。',
    '',
    '【输出格式】只输出一个 <history> 包裹的合法 XML 日志块（不要解释、不要复述规则）：',
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
  const doc = new DOMParser().parseFromString(`<${HISTORY_TAG} />`, 'text/xml');
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

/** 摘要调用结果：文本 + 可选 token usage + 成功时的尝试次数。 */
export type SummarySubagentResult = {
  text: string;
  usage?: TokenUsage;
  /** 成功时的尝试次数（1 起；载荷层换算为重试次数 = 该值 - 1）。 */
  attemptCount: number;
};

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
    doc = new DOMParser().parseFromString(xml, 'text/xml');
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
 * 解析文本中全部 <history> 块内的条目（反思输入为多个块拼接：逐块解析提取）。
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
  const doc = new DOMParser().parseFromString(`<${HISTORY_TAG} />`, 'text/xml');
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
 * 找不到或内容过短返回 null；候选块经 XML 结构校验，整块非法时按条目模糊
 * 提取重建为合法块（不要求模型输出整体合法 XML）；随后统一校验：无 reasoning、
 * index 连续且与 expected 覆盖区间一致；通过后统一改写为带 tip 属性的开标签
 * 并在块顶插入格式说明注释。
 */
export function extractSummaryLog(raw: string, expected?: SummaryValidationRange): string | null {
  const closeTag = `</${HISTORY_TAG}>`;
  const openMatch = HISTORY_OPEN_TAG_RE.exec(raw);
  const open = openMatch?.index ?? -1;
  const close = raw.lastIndexOf(closeTag);
  if (openMatch === null || close === -1 || close < open) return null;
  const inner = raw.slice(open + openMatch[0].length, close);
  if (inner.trim().length < MIN_HISTORY_LENGTH) return null;
  const block = raw.slice(open, close + closeTag.length);
  const candidate = parseHistoryBlock(block) === null ? rebuildHistoryBlock(inner) : block;
  if (candidate === null) return null;
  const parsed = parseHistoryBlock(candidate);
  if (parsed === null) return null;
  if (parsed.hasReasoning) return null;
  const span = historyContinuity(parsed.entries);
  if (span === null) return null;
  if (expected?.start !== undefined && span.start !== expected.start) return null;
  if (expected?.end !== undefined && span.end !== expected.end) return null;
  const candidateInner = candidate
    .slice(candidate.indexOf('>') + 1, candidate.length - closeTag.length)
    .trim();
  return `<${HISTORY_TAG} tip="${HISTORY_TIP}">\n${HISTORY_FORMAT_NOTE}\n${candidateInner}\n</${HISTORY_TAG}>`;
}

/** 摘要调用总尝试次数兜底（无 options.maxAttempts 时；实际由 config.compressRetryCount + 1 传入）。 */
export const SUMMARY_DEFAULT_MAX_ATTEMPTS = 11;

/** 尝试失败的简短原因（供重试日志与最终失败日志使用）。 */
type AttemptFailure = { error?: string; finish?: string };

/**
 * 直连 LLM 执行一次摘要（观察或反思），返回文本与可选 token usage。
 * 失败（抛异常 / 空输出 / 非 stop 结束 / 校验不通过）均记录日志并重试，最多尝试
 * options.maxAttempts 次；全部失败返回 null（不产生任何日志变更）。每次请求发出前
 * 先过全局限流等待门。
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
  options?: { maxAttempts?: number; expected?: SummaryValidationRange; rateLimitWaitMs?: number },
): Promise<SummarySubagentResult | null> {
  const session = agent.session;
  const logger = makeLogger(ctx, debug);
  const maxAttempts = options?.maxAttempts ?? SUMMARY_DEFAULT_MAX_ATTEMPTS;
  let lastFailure: AttemptFailure = {};
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal?.aborted) {
      logger.warn(
        `摘要调用中止（第 ${attempt}/${maxAttempts} 次尝试前 signal 已中止），放弃本次摘要`,
      );
      return null;
    }
    const rateLimitWaitMs = options?.rateLimitWaitMs ?? RATE_LIMIT_WAIT_MS_DEFAULT;
    const gated = await gateRateLimit(rateLimitWaitMs, signal);
    if (!gated) {
      logger.warn(
        `摘要调用中止（第 ${attempt}/${maxAttempts} 次尝试前限流等待被 signal 中止），放弃本次摘要`,
      );
      return null;
    }
    logger.step(
      `摘要调用开始（第 ${attempt}/${maxAttempts} 次，provider ${target.provider}，model ${target.model}，maxTokens ${
        maxTokens === undefined ? '未设置' : String(maxTokens)
      }）`,
    );
    try {
      const requestOptions = buildSummaryOptions(
        session,
        instruction,
        contextText,
        maxTokens,
        target,
        signal,
      );
      const collector = new StreamCollector();
      for await (const chunk of ctx.llm.stream(requestOptions)) collector.push(chunk);
      const text = extractSummaryLog(collector.text, options?.expected);
      const finish = collector.finish;
      if (finish.kind !== 'stop' || text === null) {
        const reason =
          finish.kind === 'stop'
            ? collector.text.trim() === ''
              ? '无输出'
              : '缺少合法 <history> 块（含 reasoning 或 index 不连续）'
            : String(finish.kind);
        lastFailure = { finish: reason };
        logger.warn(
          `摘要未完成（第 ${attempt}/${maxAttempts} 次，${reason}）` +
            (attempt < maxAttempts ? '，将重试' : '，重试耗尽，忽略本次摘要'),
        );
        continue;
      }
      const usage = collector.usage;
      logger.step(
        `摘要调用成功（第 ${attempt}/${maxAttempts} 次，输出 ${text.length} 字符` +
          (usage === undefined
            ? ''
            : `，input ${String(usage.inputTokens ?? '?')} / output ${String(usage.outputTokens ?? '?')} tokens`) +
          '）',
      );
      return { text, attemptCount: attempt, ...(usage === undefined ? {} : { usage }) };
    } catch (error) {
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
          (attempt < maxAttempts ? '，将重试' : '，重试耗尽，忽略本次摘要'),
      );
    }
  }
  logger.warn(
    `摘要调用最终失败（已尝试 ${maxAttempts} 次` +
      (lastFailure.error !== undefined ? `，最后错误：${lastFailure.error}` : '') +
      (lastFailure.finish !== undefined ? `，最后结果：${lastFailure.finish}` : '') +
      '），忽略本次摘要',
  );
  return null;
}
