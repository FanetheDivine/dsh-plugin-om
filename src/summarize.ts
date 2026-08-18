/**
 * 摘要调用（OM 观察/反思）：直连 ctx.llm.stream()，始终以 new 方式开启观察——
 * 新开会话：指令（persona + 提示词）作为 system 提示词，被压缩消息（由 compress.ts
 * 渲染传入）作为 user 消息输入模型压缩。不使用 fork 会话风格（复用主会话请求前缀
 * 需要模型自行对消息计数，会导致严重的索引异常）。
 *
 * 提示词不内嵌消息全文（被压缩消息由 compress.ts 渲染区间传入）；新消息起始 index
 * 由插件从日志计算后内嵌——AI 按「完整消息」的 index 编号（三类定义见 log-index.ts），
 * recall 用同一套编号定位。token usage 从流式响应的 usage chunk 提取，归入主会话记录。
 * 仅主会话生效（index.ts 守卫）。
 */

import type { FinishReason, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { HISTORY_TAG, HISTORY_TIP, PLUGIN_LABEL } from './constants.ts';
import { indexCompleteMessages, renderCompleteMessage } from './log-index.ts';
import { makeLogger } from './logger.ts';
import type { Agent, Context, Session, TokenUsage, UserMessage } from './types.ts';
import { type RoutedTarget, uuid } from './utils.ts';

/** 观察者 persona：只针对未压缩消息产出观察日志，不用工具、不展示思考。 */
export const OBSERVER_PERSONA =
  '把会话中尚未压缩的消息压缩为一份观察日志。不用工具、不展示思考、不评价代码、不输出多余文字。';

/** 反思者 persona：只精简合并当前摘要，不用工具、不展示思考。 */
export const REFLECTOR_PERSONA =
  '把当前 <om-history> 压缩日志精简合并为一份更紧凑的日志。不用工具、不展示思考、不输出多余文字。';

/** 观察提示词参数（起始 index 由 compress.ts 从日志计算后传入）。 */
export type ObservePromptOptions = {
  /** 本次要压缩的新消息起始完整消息 index（AI 从该序号开始编号）。 */
  startIndex: number;
  /** 是否存在旧摘要（决定「追加到上次产物末尾」的表述）。 */
  hasOldHistory: boolean;
};

/**
 * 构建观察指令主体：任务声明（说明总结日志）+ 上下文定位与压缩范围（下方消息即压缩
 * 对象）+ 完整消息与 index 定义（三类合并规则、起始编号）+ 规则（用户消息完整保留
 * 原文 / AI 消息按模块压缩 / 本指令不入日志 / index/start/end 连续 / 倾向于新消息 /
 * 未完成写进度与下一步）+ 输出格式（合法 XML）+ 追加说明。
 * persona 由调用方拼接到指令开头。
 */
export function buildObservePrompt(options: ObservePromptOptions): string {
  /** 任务声明：new 方式新开会话，说明总结日志即可。 */
  const declaration = '将过往消息总结为一份日志。';
  /** 上下文定位与压缩范围（new 方式输入结构）。 */
  const framing = [
    '下方的消息记录是本次要压缩的全部消息（上一个 <om-history> 块之后的新消息；不含旧压缩日志、不含尾部）。',
    '你的压缩结果会作为新的 <om-history> 块追加到已有压缩日志之后。',
  ];
  return [
    declaration,
    '',
    ...framing,
    '',
    '【完整消息与 index】',
    '- 完整消息分三类：用户消息占一条；AI 文本占一条；工具调用及其结果占一条（每个 tool-call 与其 result 各一条，同一条 AI 消息里的文本与工具调用拆开）。每条完整消息有一个 index（从 0 起、按会话顺序递增、全局稳定），index 是该条完整消息的序号。',
    `- 本次要压缩的新消息从 index ${options.startIndex} 开始编号，按日志顺序逐条递增；旧 <${HISTORY_TAG}> 中已有的 index 无需理会，也不要改动旧条目。`,
    '',
    '【规则】',
    '- 当前消息仅作为指令，**不得**进入日志。',
    '- 用户消息完整保留原文，输出为 <user_message index="N"> 条目（N 为该条完整消息的 index，内容为消息原文，不概括、不省略）。',
    '- 将AI 消息按照内在关联，划分为**连续消息**组成的模块，消息模块的划分方式不受限制，但内部须有足够的**逻辑连贯性**，应当是AI基于某个目的做出了一系列动作或论述',
    '- 模块内的消息聚合输出为<assistant start="" end="">块，start/end表示当前模块首尾消息的index；块内不描述单条消息的细节，只描述当前模块的**目的、行为、结果**；最后一个<assistant>块，额外包含`下一步计划`',
    '- 对于模块涉及到的具体文件，应当出现在<assistant>块中，多个前缀相同的路径要合并简写',
    '- 对于单条重要的AI完整消息，以<assistant index="">单独呈现，其内容不受限制',
    '- 条目按 index 顺序覆盖本次压缩的全部完整消息，index/start/end 必须连续（区间内 index 连续、相邻条目相接），不跳号、不重叠、不遗漏。',
    '- 总结时倾向于新消息，旧消息一句话带过即可；新旧消息冲突时强调新消息，不修改旧日志条目。',
    '【输出格式】只输出一个 <om-history> 包裹的合法 XML 日志块，不要解释、不要复述规则：',
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
    ...(options.hasOldHistory
      ? [
          `【说明】你的压缩结果会被直接追加到上一次压缩产物（<${HISTORY_TAG}>）的末尾，作为新的 <${HISTORY_TAG}> 块；条目格式与本块一致。`,
        ]
      : [`【说明】你的压缩结果将成为第一条 <${HISTORY_TAG}> 压缩日志。`]),
  ].join('\n');
}

/** 构建反思指令主体：任务声明（说明总结日志）+ 精简合并当前 <om-history> 的规则 +
 * 输出格式（合法 XML）；消息记录全文由渲染输入（new 方式）提供。 */
export function buildReflectPrompt(): string {
  /** 任务声明：new 方式新开会话，说明总结日志即可。 */
  const declaration = '将当前压缩日志精简合并为一份更紧凑的日志。';
  /** 上下文定位说明（new 方式输入结构）。 */
  const framing = [
    '下方的消息记录包含当前的 <om-history> 压缩日志（全部 <om-history> 块）。',
    '只对这份压缩日志做精简合并；不要涉及日志之外的消息。',
  ];
  return [
    declaration,
    '',
    ...framing,
    '',
    '【规则】',
    '- 当前消息仅作为指令，**不得**进入日志。',
    '- 完整消息分三类（用户消息 / AI 文本 / 单个工具调用及其结果），各占一个 index（从 0 起、会话内全局稳定），index 是该条完整消息的序号。',
    '- 将AI 消息按照内在关联，划分为**连续消息**组成的模块，消息模块的划分方式不受限制，但内部须有足够的**逻辑连贯性**，应当是AI基于某个目的做出了一系列动作或论述',
    '- 模块内的消息聚合输出为<assistant start="" end="">块，start/end表示当前模块首尾消息的index；块内不描述单条消息的细节，只描述当前模块的**目的、行为、结果**；最后一个<assistant>块，额外包含`下一步计划`',
    '- 对于模块涉及到的具体文件，应当出现在<assistant>块中，多个前缀相同的路径要合并简写',
    '- 对于单条重要的AI完整消息，以<assistant index="">单独呈现，其内容不受限制',
    '- 用户消息保留要点与 index（格式：<user_message index="(index)"> 要点 </user_message>）；不重要的内容概括为「（略）」。',
    '- 条目按 index 顺序覆盖日志中的全部完整消息，index/start/end 必须连续（区间内 index 连续、相邻条目相接），不跳号、不重叠、不遗漏；合并时条目的 index 不重新编号。',
    '- 过时事实丢弃，不逐字复制旧文本；新旧条目冲突时保留新条目。',
    '【输出格式】只输出一个 <om-history> 包裹的合法 XML 日志块，不要解释、不要复述规则：',
    `<${HISTORY_TAG}>`,
    '<user_message index="(index)">',
    '(user 消息要点)',
    '</user_message>',
    '<assistant start="(起始 index)" end="(结束 index)">',
    '(模块的目的、行为与结果摘要)',
    '</assistant>',
    '<assistant index="(index)">',
    '(单条完整消息的模块摘要)',
    '</assistant>',
    `</${HISTORY_TAG}>`,
    '',
    `【说明】你的合并结果会替换全部 <${HISTORY_TAG}> 块。`,
  ].join('\n');
}

/**
 * 摘要调用结果：文本 + 可选 token usage（摘要请求自身消耗，随 compaction/summary
 * 归入主会话记录）。
 */
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

/**
 * 渲染完整消息记录（new 模式输入）：按完整消息渲染为合法 XML，每条带绝对 index——
 *  - user → <user_message index="N">(原文)</user_message>；
 *  - assistant / toolcall → <assistant index="N">(文本 / 调用参数+结果)</assistant>。
 * 仅渲染 seqs 全部落在给定集合内的完整消息（插件自产消息天然不占位）。
 */
export function renderMessages(session: Session, seqs: readonly number[]): string {
  /** 遮蔽 seq 集合。 */
  const shadowed = new Set(seqs);
  /** 渲染段缓冲区。 */
  const parts: string[] = [];
  for (const cm of indexCompleteMessages(session)) {
    if (!cm.seqs.every((seq) => shadowed.has(seq))) continue;
    /** 该条完整消息的文本（空内容跳过）。 */
    const text = renderCompleteMessage(session, cm);
    if (text.trim() === '') continue;
    /** 标签（user 与 AI 侧分属两种条目）。 */
    const tag = cm.type === 'user' ? 'user_message' : 'assistant';
    parts.push(`<${tag} index="${cm.index}">\n${text}\n</${tag}>`);
  }
  return parts.join('\n\n');
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

/** 日志最小有效长度：<om-history> 中间内容小于该长度视为不合法（C 段校验）。 */
export const MIN_HISTORY_LENGTH = 10;

/** 产出日志后插入首个 <om-history> 后的格式说明（XML 注释，避免被误读为日志条目）。 */
export const HISTORY_FORMAT_NOTE =
  '<!-- 完整消息分三类（用户消息 / AI 文本 / 单个工具调用及其结果），各占一个 index（从 0 起、会话内全局稳定）；<user_message index="N"> 与 <assistant index="N"> 表示单条完整消息，<assistant start="A" end="B"> 表示多条完整消息，start/end是首尾消息的index -->';

/**
 * 从 AI 摘要输出中提取合法日志（不信任 AI 的总结结果）：
 *  - 取首个 <om-history> 到最后一个 </om-history>（含两个首尾）切为日志；
 *  - 找不到、顺序颠倒（首个开标签在最后一个闭标签之后）或中间内容长度 < MIN_HISTORY_LENGTH
 *    视为不合法（返回 null，调用方按失败重试）；
 *  - 产出后把首个开标签改写为带 tip 属性的版本（对 AI 的提醒），并在其后插入
 *    格式说明注释（HISTORY_FORMAT_NOTE，块顶）。
 */
export function extractSummaryLog(raw: string): string | null {
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
  /** 完整日志块（含两个首尾）。 */
  const block = raw.slice(open, close + closeTag.length);
  /** 首个开标签改写为带 tip 版本，块顶紧跟格式说明注释。 */
  return block
    .replace(openTag, openTagWithTip)
    .replace(openTagWithTip, `${openTagWithTip}\n${HISTORY_FORMAT_NOTE}`);
}

/** 单次摘要最多尝试次数（首次 + 失败重试，总上限；失败/未完成均重试）。 */
export const SUMMARY_MAX_ATTEMPTS = 3;

/** 尝试失败的简短原因（供重试日志与最终失败日志使用）。 */
type AttemptFailure = { error?: string; finish?: string };

/**
 * 直连 LLM 执行一次摘要（观察或反思），返回文本与可选 token usage。
 * 失败（抛异常 / 空输出 / 非 stop 结束）均记录日志并重试，总共最多尝试
 * SUMMARY_MAX_ATTEMPTS 次；全部尝试失败返回 null（不产生任何日志变更）。
 * 输出长度受 maxTokens 限制。
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
): Promise<SummarySubagentResult | null> {
  /** 当前会话。 */
  const session = agent.session;
  /** 插件日志门面（失败日志始终输出）。 */
  const logger = makeLogger(ctx, debug);
  /** 最后一次失败的原因（error=调用异常 / finish=未完成原因；最终失败日志使用）。 */
  let lastFailure: AttemptFailure = {};
  for (let attempt = 1; attempt <= SUMMARY_MAX_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) {
      logger.warn(
        `摘要调用中止（第 ${attempt}/${SUMMARY_MAX_ATTEMPTS} 次尝试前 signal 已中止），放弃本次摘要`,
      );
      return null;
    }
    logger.step(
      `摘要调用开始（第 ${attempt}/${SUMMARY_MAX_ATTEMPTS} 次，provider ${target.provider}，model ${target.model}，maxTokens ${maxTokens}）`,
    );
    try {
      /** 摘要请求选项（new 方式组装）。 */
      const options = buildSummaryOptions(
        session,
        instruction,
        contextText,
        maxTokens,
        target,
        signal,
      );
      /** 流收集器（文本/usage/finish）。 */
      const collector = new StreamCollector();
      for await (const chunk of ctx.llm.stream(options)) collector.push(chunk);
      /** 提取合法日志（首个 <om-history> 到最后一个 </om-history>，含格式说明注释；不信任 AI 输出）。 */
      const text = extractSummaryLog(collector.text);
      /** 终止原因（仅 stop 视为完成）。 */
      const finish = collector.finish;
      if (finish.kind !== 'stop' || text === null) {
        /** 未完成原因（空输出 / 非法日志 / 非 stop 终止原因）。 */
        const reason =
          finish.kind === 'stop'
            ? collector.text.trim() === ''
              ? '无输出'
              : '缺少 <om-history> 块或内容过短'
            : String(finish.kind);
        lastFailure = { finish: reason };
        logger.warn(
          `摘要未完成（第 ${attempt}/${SUMMARY_MAX_ATTEMPTS} 次，${reason}）` +
            (attempt < SUMMARY_MAX_ATTEMPTS ? '，将重试' : '，重试耗尽，忽略本次摘要'),
        );
        continue;
      }
      /** 摘要请求的 token usage（归入主会话记录；无则省略）。 */
      const usage = collector.usage;
      logger.step(
        `摘要调用成功（第 ${attempt}/${SUMMARY_MAX_ATTEMPTS} 次，输出 ${text.length} 字符` +
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
        `摘要调用失败（第 ${attempt}/${SUMMARY_MAX_ATTEMPTS} 次，${message}）` +
          (attempt < SUMMARY_MAX_ATTEMPTS ? '，将重试' : '，重试耗尽，忽略本次摘要'),
      );
    }
  }
  /** 全部尝试失败：记录最终失败日志（含最后原因，便于诊断）。 */
  logger.warn(
    `摘要调用最终失败（已尝试 ${SUMMARY_MAX_ATTEMPTS} 次` +
      (lastFailure.error !== undefined ? `，最后错误：${lastFailure.error}` : '') +
      (lastFailure.finish !== undefined ? `，最后结果：${lastFailure.finish}` : '') +
      '），忽略本次摘要',
  );
  return null;
}
