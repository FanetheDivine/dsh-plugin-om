/**
 * 摘要调用（OM 观察/反思）：直连 ctx.llm.stream()，始终以 new 方式开启观察——
 * 新开会话：指令（共享提示词）作为 system 提示词，被压缩消息（由 compress.ts 渲染传入）
 * 作为 user 消息输入模型压缩。观察与反思共用同一套系统提示词（buildHistoryPrompt）：
 * 输入与输出都是合法的 <history> 块（模型消息 + index 的表达形式），先定义块、要求压缩、
 * 再给出数据源（下方 <history> 消息记录）。
 *
 * 观察输入由 renderMessages 渲染为 <history> 块：用户消息文本原样（图片/文件以注释补充）、
 * <reasoning> 参考条目（产物中没有）、assistant 文本与 toolcall&result 原样。
 * 输出经 extractSummaryLog 校验：合法 <history> 块、不含 <reasoning>、index/start/end 连续
 * （与预期覆盖区间一致），失败按 config.compressRetryCount 重试。
 * token usage 从流式响应的 usage chunk 提取，归入主会话记录。仅主会话生效（index.ts 守卫）。
 */

import type { FinishReason, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import {
  COMPLETE_MESSAGE_DEFINITION,
  HISTORY_TAG,
  HISTORY_TIP,
  PLUGIN_LABEL,
} from './constants.ts';
import { indexCompleteMessages, renderCompleteMessage } from './log-index.ts';
import { makeLogger } from './logger.ts';
import type { Agent, CompleteMessage, Context, Session, TokenUsage, UserMessage } from './types.ts';
import { type RoutedTarget, uuid } from './utils.ts';

/**
 * 共享压缩提示词（观察/反思同一套）：定义 history 块（模型消息 + index 的表达形式）、
 * 完整消息定义、要求压缩（完整保留用户消息 / reasoning 仅参考 / 关联 assistant 合并 /
 * index/start/end 连续）、输出格式（一个合法 <history> 块，无 reasoning）、数据源说明。
 */
export function buildHistoryPrompt(): string {
  return [
    '把下方的 <history> 消息记录压缩为一份更紧凑的 <history> 压缩日志。不用工具、不展示思考、不输出多余文字。',
    '',
    '【history 块定义】',
    '- <history> 是历史消息的记录块：输入与输出都是合法的 <history> 块，块内条目是「模型消息 + index」的表达形式。',
    `- 完整消息：${COMPLETE_MESSAGE_DEFINITION}`,
    '- <user_message index="N">：用户消息条目（N 为该条完整消息的 index；文本原样，图片/文件等以注释补充）。',
    '- <reasoning>：模型的思考过程，仅作压缩参考，产物中不要出现。',
    '- <assistant index="N">：单条完整消息（模型输出文本，或 toolcall 及其 result）。',
    '- <assistant start="A" end="B">：多条连续完整消息聚合的模块（A/B 为模块首尾完整消息的 index）。',
    '',
    '【压缩要求】',
    '- 完整保留用户消息：<user_message> 条目逐条保留原文，不概括、不省略。',
    '- <reasoning> 只作参考，输出产物中不包含 <reasoning> 块。',
    '- 将具有关联性的 <assistant> 消息按内在逻辑连贯性划分为连续模块，聚合为 <assistant start="" end=""> 块：块内描述模块的目的、行为与结果，最后一个模块额外给出`下一步计划`；涉及的具体文件保留在模块内容中，多个前缀相同的路径合并简写。',
    '- 单条重要的完整消息以 <assistant index=""> 单独呈现，内容不受限制。',
    '- 条目按 index 顺序覆盖本次压缩的全部完整消息：index/start/end 必须连续（区间内 index 连续、相邻条目相接），不跳号、不重叠、不遗漏。',
    '',
    '【输出格式】只输出一个 <history> 包裹的合法 XML 日志块（不要解释、不要复述规则）：',
    `<${HISTORY_TAG}>`,
    '<user_message index="(index)">',
    '(user 消息原文)',
    '</user_message>',
    '<assistant start="(起始 index)" end="(结束 index)">',
    '(模块的目的、行为与结果摘要)',
    '</assistant>',
    '<assistant index="(index)">',
    '(单条完整消息的模块摘要)',
    '</assistant>',
    `</${HISTORY_TAG}>`,
    '',
    '【数据源】下方的 <history> 消息记录是本次要压缩的全部消息；压缩结果作为一个新的 <history> 块输出。',
  ].join('\n');
}

/** 渲染用户消息条目：文本块原样拼接；图片/文件等非文本块以注释补充（说明传入了什么）。 */
function renderUserEntry(session: Session, cm: CompleteMessage): string | null {
  /** 用户消息事件（seq 缺失则无法渲染）。 */
  const seq = cm.seqs[0];
  const event = seq === undefined ? undefined : session.events[seq];
  /** 派生的消息对象。 */
  const message = event ? session.deriveEventMessage(event) : null;
  if (!message || !Array.isArray(message.content)) return null;
  /** 文本块拼接 + 非文本块注释。 */
  const texts: string[] = [];
  const notes: string[] = [];
  for (const block of message.content) {
    if (block.type === 'text') {
      texts.push(String(block.text));
    } else if (block.type === 'image') {
      /** 图片附件元数据（名称 / 媒体类型 / 尺寸 / 字节数）。 */
      const ref = block.attachment as
        | { name?: string; mediaType?: string; width?: number; height?: number; bytes?: number }
        | undefined;
      /** 显示名（有则附上）。 */
      const name = ref?.name ? `：${ref.name}` : '';
      /** 元数据串。 */
      const meta = ref
        ? `（${String(ref.mediaType ?? '')} ${String(ref.width ?? '')}×${String(ref.height ?? '')}，${String(ref.bytes ?? '')} bytes）`
        : '';
      notes.push(`<!-- 图片附件${name}${meta} -->`);
    } else {
      notes.push(`<!-- ${String(block.type)} 块 -->`);
    }
  }
  /** 条目正文（文本 + 注释）。 */
  const body = [...texts, ...notes].join('\n');
  if (body.trim() === '') return null;
  return `<user_message index="${cm.index}">\n${body}\n</user_message>`;
}

/**
 * 渲染完整消息记录（观察输入，new 模式）：输出一个合法的 <history> 块——
 *  - user → <user_message index="N">（文本原样 + 图片/文件注释）；
 *  - 每条 assistant 消息的 reasoning → <reasoning>（参考条目，产物中没有）；
 *  - assistant / toolcall → <assistant index="N">（模型输出文本 / toolcall&result 原样）。
 * 仅渲染 seqs 全部落在给定集合内的完整消息（插件自产消息天然不占位）。
 */
export function renderMessages(session: Session, seqs: readonly number[]): string {
  /** 遮蔽 seq 集合。 */
  const shadowed = new Set(seqs);
  /** 各 assistant 消息的 reasoning 文本（seq → 文本列表，按日志顺序）。 */
  const reasoningBySeq = new Map<number, string[]>();
  for (const seq of seqs) {
    /** 当前 assistant 消息（非消息事件跳过）。 */
    const event = session.events[seq];
    if (event?.type !== 'assistant/message') continue;
    const message = event.data.message;
    if (!message || !Array.isArray(message.content)) continue;
    /** 该消息的 reasoning 块文本。 */
    const reasonings: string[] = [];
    for (const block of message.content) {
      if (block.type === 'reasoning' && typeof block.text === 'string') reasonings.push(block.text);
    }
    if (reasonings.length > 0) reasoningBySeq.set(seq, reasonings);
  }
  /** 已输出 reasoning 的 assistant 消息 seq（每条消息的 reasoning 只输出一次）。 */
  const emittedReasoning = new Set<number>();
  /** 渲染段缓冲区。 */
  const parts: string[] = [];
  for (const cm of indexCompleteMessages(session)) {
    if (!cm.seqs.every((seq) => shadowed.has(seq))) continue;
    if (cm.type === 'user') {
      /** 用户消息条目（无文本且无注释则跳过）。 */
      const rendered = renderUserEntry(session, cm);
      if (rendered === null) continue;
      parts.push(rendered);
    } else {
      // assistant / toolcall 条目：先输出所属 assistant 消息的 reasoning（参考用）
      /** 承载该条完整消息的 assistant seq（缺失则无 reasoning 可输出）。 */
      const callSeq = cm.seqs[0];
      /** 该消息的 reasoning（无则跳过）。 */
      const reasonings = callSeq === undefined ? undefined : reasoningBySeq.get(callSeq);
      if (callSeq !== undefined && reasonings !== undefined && !emittedReasoning.has(callSeq)) {
        emittedReasoning.add(callSeq);
        for (const text of reasonings) parts.push(`<reasoning>\n${text}\n</reasoning>`);
      }
      /** 该条完整消息的文本（assistant=文本；toolcall=调用参数+结果，原样）。 */
      const text = renderCompleteMessage(session, cm);
      if (text.trim() === '') continue;
      parts.push(`<assistant index="${cm.index}">\n${text}\n</assistant>`);
    }
  }
  return `<${HISTORY_TAG}>\n${parts.join('\n')}\n</${HISTORY_TAG}>`;
}

/** 摘要调用结果：文本 + 可选 token usage（摘要请求自身消耗，随 compaction/summary 归入主会话记录）。 */
export type SummarySubagentResult = {
  text: string;
  usage?: TokenUsage;
};

/** 流收集器：提取文本输出 + usage + finish（不依赖宿主 BlockAssembler，保持零运行时依赖）。 */
class StreamCollector {
  /** 文本输出缓冲（text-delta 拼接；reasoning 不计入）。 */
  private textBuf = '';
  /** usage chunk（无则 undefined）。 */
  private _usage: TokenUsage | undefined;
  /** finish chunk（流结束仍无则视为 stop）。 */
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

/** 构造插件自产 user 消息（指令或 new 模式的输入消息；id 为品牌类型 MessageId）。 */
function makePluginUserMessage(text: string): UserMessage {
  return {
    id: uuid() as unknown as UserMessage['id'],
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: PLUGIN_LABEL },
  } as unknown as UserMessage;
}

/**
 * 构建摘要请求选项（new 方式）：指令作为 system，渲染输入（被压缩消息）作为
 * 唯一的 user 消息——不沿用主会话请求前缀（前缀复用需模型自行计数，导致索引异常）。
 */
function buildSummaryOptions(
  session: Session,
  instruction: string,
  contextText: string | undefined,
  maxTokens: number,
  target: RoutedTarget,
  signal: AbortSignal | undefined,
): GenerateOptions {
  return {
    provider: target.provider,
    model: target.model,
    maxTokens,
    sessionId: session.id,
    purpose: 'compaction' as const,
    ...(signal === undefined ? {} : { signal }),
    system: instruction,
    messages: [makePluginUserMessage(contextText ?? '')],
  };
}

/** 日志最小有效长度：<history> 中间内容小于该长度视为不合法（C 段校验）。 */
export const MIN_HISTORY_LENGTH = 10;

/** 产出日志后插入首个 <history> 后的格式说明（XML 注释，完整消息定义 + 条目标签语义）。 */
export const HISTORY_FORMAT_NOTE = `<!-- 完整消息：${COMPLETE_MESSAGE_DEFINITION} <user_message index="N"> 与 <assistant index="N"> 表示单条完整消息，<assistant start="A" end="B"> 表示连续模块，start/end 是首尾完整消息的 index -->`;

/** history 块内条目（单条 index 或模块 start/end）。 */
export type HistoryEntryRange = {
  kind: 'user' | 'assistant';
  index?: number;
  start?: number;
  end?: number;
};

/**
 * 解析 history 块内的条目：<user_message index="N"> / <assistant index="N"> /
 * <assistant start="A" end="B">。仅提取不校验顺序（连续性由 historyContinuity 校验）。
 */
export function parseHistoryEntries(text: string): HistoryEntryRange[] {
  /** 条目缓冲区。 */
  const out: HistoryEntryRange[] = [];
  /** 单条（index）与模块（start..end）按文本顺序统一匹配。 */
  const entryRe = /<(user_message|assistant)\s+(?:index="(\d+)"|start="(\d+)"\s+end="(\d+)")/g;
  for (const m of text.matchAll(entryRe)) {
    /** 条目类别（user_message=用户消息，assistant=模型输出）。 */
    const kind = m[1] === 'user_message' ? 'user' : 'assistant';
    if (m[2] !== undefined) {
      out.push({ kind, index: Number(m[2]) });
    } else {
      out.push({ kind, start: Number(m[3]), end: Number(m[4]) });
    }
  }
  return out;
}

/**
 * 校验条目 index/start/end 连续性：每条给出覆盖区间 [lo, hi]（单条 index 为自身），
 * 按块内出现顺序，相邻条目必须首尾相接（后一条 lo = 前一条 hi + 1），返回整体覆盖区间；
 * 空条目 / 非法范围（start > end） / 跳号、重叠或乱序 → 返回 null。
 */
export function historyContinuity(
  entries: HistoryEntryRange[],
): { start: number; end: number } | null {
  if (entries.length === 0) return null;
  /** 各条目覆盖区间（保持块内出现顺序）。 */
  const ranges: Array<{ lo: number; hi: number }> = [];
  for (const e of entries) {
    /** 模块（start/end）或单条（index 为自身）。 */
    const lo = e.kind === 'assistant' && e.start !== undefined ? e.start : (e.index ?? 0);
    const hi = e.kind === 'assistant' && e.end !== undefined ? e.end : (e.index ?? 0);
    if (lo > hi) return null;
    ranges.push({ lo, hi });
  }
  for (let i = 1; i < ranges.length; i += 1) {
    /** 相邻两条（防御性判空）。 */
    const prev = ranges[i - 1];
    const curr = ranges[i];
    if (prev === undefined || curr === undefined) return null;
    if (curr.lo !== prev.hi + 1) return null;
  }
  /** 首尾条目（防御性判空）。 */
  const first = ranges[0];
  const last = ranges[ranges.length - 1];
  if (first === undefined || last === undefined) return null;
  return { start: first.lo, end: last.hi };
}

/** 校验期望覆盖区间（外部传入；仅校验提供的字段，缺省字段跳过）。 */
export type SummaryValidationRange = { start?: number; end?: number };

/**
 * 从 AI 摘要输出中提取合法日志（不信任 AI 的总结结果）：
 *  - 取首个 <history> 到最后一个 </history>（含两个首尾）切为日志；
 *  - 找不到、顺序颠倒（首个开标签在最后一个闭标签之后）或中间内容长度 < MIN_HISTORY_LENGTH
 *    视为不合法（返回 null，调用方按失败重试）；
 *  - 产物不允许包含 <reasoning> 块（仅作参考）；
 *  - index/start/end 连续性校验（historyContinuity + 与 expected 覆盖区间一致）；
 *  - 产出后把首个开标签改写为带 tip 属性的版本（对 AI 的提醒），并在其后插入
 *    格式说明注释（HISTORY_FORMAT_NOTE，块顶）。
 */
export function extractSummaryLog(raw: string, expected?: SummaryValidationRange): string | null {
  /** 开标签（模型输出格式）。 */
  const openTag = `<${HISTORY_TAG}>`;
  /** 闭标签。 */
  const closeTag = `</${HISTORY_TAG}>`;
  /** 带 tip 属性的开标签（插件产出格式）。 */
  const openTagWithTip = `<${HISTORY_TAG} tip="${HISTORY_TIP}">`;
  /** 首个开标签位置（无则 -1）。 */
  const open = raw.indexOf(openTag);
  /** 最后一个闭标签位置（无则 -1）。 */
  const close = raw.lastIndexOf(closeTag);
  if (open === -1 || close === -1 || close < open) return null;
  /** 中间内容（开闭标签之间）。 */
  const inner = raw.slice(open + openTag.length, close);
  if (inner.trim().length < MIN_HISTORY_LENGTH) return null;
  // 产物不允许包含 reasoning 块（仅作参考）
  if (/<\/?reasoning\b/i.test(inner)) return null;
  // index/start/end 连续性（区间内连续、相邻相接、不跳号不重叠）
  /** 条目覆盖区间。 */
  const span = historyContinuity(parseHistoryEntries(inner));
  if (span === null) return null;
  if (expected?.start !== undefined && span.start !== expected.start) return null;
  if (expected?.end !== undefined && span.end !== expected.end) return null;
  /** 完整日志块（含两个首尾）。 */
  const block = raw.slice(open, close + closeTag.length);
  /** 首个开标签改写为带 tip 版本，块顶紧跟格式说明注释。 */
  return block
    .replace(openTag, openTagWithTip)
    .replace(openTagWithTip, `${openTagWithTip}\n${HISTORY_FORMAT_NOTE}`);
}

/** 摘要调用总尝试次数兜底（无 options.maxAttempts 时；实际由 config.compressRetryCount + 1 传入）。 */
export const SUMMARY_DEFAULT_MAX_ATTEMPTS = 11;

/** 尝试失败的简短原因（供重试日志与最终失败日志使用）。 */
type AttemptFailure = { error?: string; finish?: string };

/**
 * 直连 LLM 执行一次摘要（观察或反思），返回文本与可选 token usage。
 * 失败（抛异常 / 空输出 / 非 stop 结束 / 校验不通过）均记录日志并重试，总共最多尝试
 * options.maxAttempts 次（默认 SUMMARY_DEFAULT_MAX_ATTEMPTS）；全部尝试失败返回 null
 * （不产生任何日志变更）。输出长度受 maxTokens 限制。
 */
export async function runSummarySubagent(
  ctx: Context,
  agent: Agent,
  instruction: string,
  contextText: string | undefined,
  maxTokens: number,
  target: RoutedTarget,
  debug: boolean,
  signal?: AbortSignal,
  options?: { maxAttempts?: number; expected?: SummaryValidationRange },
): Promise<SummarySubagentResult | null> {
  /** 当前会话。 */
  const session = agent.session;
  /** 插件日志门面（失败日志始终输出）。 */
  const logger = makeLogger(ctx, debug);
  /** 总尝试次数（首次 + 重试；缺省兜底）。 */
  const maxAttempts = options?.maxAttempts ?? SUMMARY_DEFAULT_MAX_ATTEMPTS;
  /** 最后一次失败的原因（error=调用异常 / finish=未完成原因；最终失败日志使用）。 */
  let lastFailure: AttemptFailure = {};
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal?.aborted) {
      logger.warn(
        `摘要调用中止（第 ${attempt}/${maxAttempts} 次尝试前 signal 已中止），放弃本次摘要`,
      );
      return null;
    }
    logger.step(
      `摘要调用开始（第 ${attempt}/${maxAttempts} 次，provider ${target.provider}，model ${target.model}，maxTokens ${maxTokens}）`,
    );
    try {
      /** 摘要请求选项（new 方式组装）。 */
      const requestOptions = buildSummaryOptions(
        session,
        instruction,
        contextText,
        maxTokens,
        target,
        signal,
      );
      /** 流收集器（文本/usage/finish）。 */
      const collector = new StreamCollector();
      for await (const chunk of ctx.llm.stream(requestOptions)) collector.push(chunk);
      /** 提取合法日志（首个 <history> 到最后一个 </history>，无 reasoning、index 连续；不信任 AI 输出）。 */
      const text = extractSummaryLog(collector.text, options?.expected);
      /** 终止原因（仅 stop 视为完成）。 */
      const finish = collector.finish;
      if (finish.kind !== 'stop' || text === null) {
        /** 未完成原因（空输出 / 非法日志 / 校验不通过 / 非 stop 终止原因）。 */
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
      /** 摘要请求的 token usage（归入主会话记录；无则省略）。 */
      const usage = collector.usage;
      logger.step(
        `摘要调用成功（第 ${attempt}/${maxAttempts} 次，输出 ${text.length} 字符` +
          (usage === undefined
            ? ''
            : `，input ${String(usage.inputTokens ?? '?')} / output ${String(usage.outputTokens ?? '?')} tokens`) +
          '）',
      );
      return { text, ...(usage === undefined ? {} : { usage }) };
    } catch (error) {
      /** 错误信息（统一为字符串）。 */
      const message = error instanceof Error ? error.message : String(error);
      lastFailure = { error: message };
      logger.warn(
        `摘要调用失败（第 ${attempt}/${maxAttempts} 次，${message}）` +
          (attempt < maxAttempts ? '，将重试' : '，重试耗尽，忽略本次摘要'),
      );
    }
  }
  /** 全部尝试失败：记录最终失败日志（含最后原因，便于诊断）。 */
  logger.warn(
    `摘要调用最终失败（已尝试 ${maxAttempts} 次` +
      (lastFailure.error !== undefined ? `，最后错误：${lastFailure.error}` : '') +
      (lastFailure.finish !== undefined ? `，最后结果：${lastFailure.finish}` : '') +
      '），忽略本次摘要',
  );
  return null;
}
