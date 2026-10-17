/**
 * 工具驱动的压缩循环：以新会话方式直连 ctx.llm.stream()，模型通过 getHistory /
 * compressHistory / completeCompression 完成压缩，存在原始合法提问时加入重写工具。
 * 导出 runCompressionLoop / buildCompressionPrompt / buildCompressionTaskText /
 * REFLECT_COMPRESSION_PROMPT / ASK_COMPRESSION_PROMPT / CompressionLoopOptions / CompressionOutcome / CompressionStats / COMPRESSION_NUDGE_TEXT / TRUNCATION_NUDGE_TEXT。
 *
 * - 首条 user 消息仅含压缩指令与 start/end 区间（buildCompressionTaskText），不含
 *   历史消息内容；共享压缩提示词作为 system，反思 pass 追加反思合并约束
 * - 每轮请求携带压缩工具 schemas（purpose='compaction'，maxTokens 沿用配置）；流经
 *   BlockAssembler 组装为 assistant 消息，工具执行结果以 tool-result 消息回填
 * - completeCompression 校验通过后立即停止（同轮后续工具调用不再执行），最终 <history>
 *   块由 CompressionState 构建，全程无需整块校验
 * - 模型输出纯文本（无工具调用）时追加提醒消息继续，连续 3 轮仍无工具调用判失败
 * - 输出被 max-tokens 截断且无工具调用时单独计数：该轮 assistant 消息仅落盘、不进入后续
 *   请求，追加截断专用提醒，连续 3 轮截断判失败；任一轮有工具调用则两个计数清零
 * - 429 限流走全局限流等待门（gateRateLimit / noteRateLimit）；瞬时错误（5xx、网络类）
 *   同样经限流门等待后重试，连续最多重试 3 次，任一轮成功响应后清零；重试轮不计入轮数；
 *   其余请求级错误（含 4xx）直接判失败
 * - signal 中止标记 aborted；token usage 汇总全部轮次；统计循环起止时间戳、总耗时
 *   与逐轮请求统计（CompressionStats），随结果返回并随会话记录落盘
 * - 成功与失败均把循环消息组落盘为子会话（recordCompressionSession，system 一并落盘
 *   为 system/message），成功记录 sessionId 于日志，失败记录作为诊断子会话 id 向上传播
 */

import {
  BlockAssembler,
  createToolResultMessage,
  createUserMessage,
  type GenerateOptions,
  type Message,
  type ReasoningEffortId,
  type TokenUsage,
  type ToolCallBlock,
  type UserMessage,
} from '@deepseek-ai/dsh-llm';
import {
  type CompressionFailureInfo,
  compressionInfo,
  recordCompressionSession,
} from './compaction-log.ts';
import {
  COMPRESSION_TOOL_SCHEMAS,
  CompressionState,
  REWRITE_ASK_TOOL_SCHEMA,
  type ToolCallResult,
} from './compress-tools.ts';
import type { CompressionView } from './compress-view.ts';
import { COMPACTION_ABORTED_ERROR, COMPLETE_MESSAGE_DEFINITION, omSource } from './constants.ts';
import { makeLogger } from './logger.ts';
import { gateRateLimit, isRateLimitError, noteRateLimit } from './rate-limit.ts';
import type { Context, Session } from './types.ts';
import type { RoutedTarget } from './utils.ts';

/**
 * 共享压缩提示词（观察/反思同一套）：完整消息定义、工具语义、压缩要求、skill 与
 * ask_user_question 规则、提交方式。作为压缩会话的 system；skipReasoning=true 时
 * 省略 <reasoning> 说明行。
 */
export function buildCompressionPrompt(skipReasoning: boolean): string {
  const lines: string[] = [
    '压缩历史消息为摘要。你应当通过工具查看、压缩并完成提交。',
    '',
    `【完整消息定义】${COMPLETE_MESSAGE_DEFINITION}`,
    '',
    '【工具】',
    '- getHistory(option?: {start?, end?})：查看压缩区间内的历史条目。start/end 缺省为要求区间的第一个/最后一个完整消息 index，必须在要求区间内。返回当前状态，不带 <history> 包裹：本次已压缩的区间显示为摘要条目，注释头列出这些区间；区间切入已有 <history> 块时返回整块。',
    '- compressHistory(option?: {index?, start?, end?, content})：把 index 单条或 start..end 连续区间的 assistant 类条目替换为 content 摘要（纯文本，不要包含 CDATA 包裹，插件自动包裹）。index 与 start/end 二选一，start==end 等同 index。区间不得覆盖用户消息；与已有替换区间部分重叠会被拒绝，完全包含则覆盖。返回成功即已生效，无需查看验证，不要用单条 index 试探；修改已提交的摘要时用相同或更大的区间重新提交。',
    '- completeCompression()：全部压缩完成后调用，立即结束。',
    '',
    '【压缩要求】',
    '- 先用 getHistory 查看区间内容，再划分模块分批压缩；用户消息不可压缩、保持原样，无需处理。',
    ...(skipReasoning ? [] : ['- <reasoning> 仅作压缩参考，不进产物。']),
    '- 将具有关联性的 assistant 消息按内在逻辑连贯性划分为连续模块，聚合为区间压缩（start..end）',
    '- 单条重要的完整消息以 index 单独压缩',
    '- 压缩后的 assistant 消息内，应当描述**行为逻辑**，强调关键的**结论、产出和任务**；涉及到的具体文件保留完整路径',
    '- 摘要粒度按后续用途分配，与消息位置无关：',
    '  - 未完成的任务、当前状态、待办与未解决的问题保留细节；涉及的文件写明最新状态。',
    '  - 已完成的子任务只保留结果、决策及理由、排除的方案及原因。',
    '  - 不可再生的信息不论早晚都要保留：用户提出的约束与偏好、做出的决策、报错原文、外部返回的关键数据、验证过的结论。',
    '  - 可以低成本重新获取的内容（文件内容、命令输出、搜索结果）只记来源与要点。',
    '- <history> 条目正文以 CDATA 包裹，CDATA 内为逐字原样内容。',
    '- 工具调用条目为 <assistant index="N" type="toolcall" tool-name="…">，内含 <tool-args>（调用参数 JSON）与 <tool-result>（工具返回内容）两个 CDATA 子元素。',
    '- 加载的 skill 以 <skill_content name="…" index="N"> 条目呈现，内含 <skill_resources> 与 <skill_instructions> 两段，内文为加载的 skill 内容，属于关键信息。仅在你明确判断该 skill 与后续任务无关时，压缩它；如果该 skill 与后续任务相关，或者你无法判断，不要压缩，**保持原文**。',
    '- 已有 <history> 块中的 ask_user_question 以 <ask-user-question index="N"> 呈现，CDATA 内为逐题成对的 q:（问题文本）与 a:（用户回答）行，未作答的题记为 a:(未回答)。这些提问已经处理；仅在明确判断与后续任务无关时压缩，否则保持原样。原始提问按本会话的专用处理规则执行。',
    '- 除原始提问外，未压缩的条目将原样保留；宁可保留也不要强行压缩不确定的内容。',
    '- 全部完成后调用 completeCompression 结束；不要输出与工具调用无关的文本。',
  ];
  return lines.join('\n');
}

/**
 * 构建压缩会话首条 user 消息文本（压缩指令 + start/end 区间，不含历史消息内容）。
 */
export function buildCompressionTaskText(
  phase: 'observe' | 'reflect',
  start: number,
  end: number,
): string {
  if (phase === 'reflect') {
    return `合并压缩全部 <history> 块，完整消息区间 [${start}..${end}]：用 getHistory 查看已有块条目，用 compressHistory 重新压缩合并 assistant 条目，完成后调用 completeCompression。`;
  }
  return `压缩完整消息区间 [${start}..${end}]：用 getHistory 查看条目，用 compressHistory 分批压缩 assistant 条目，完成后调用 completeCompression。`;
}

/** 反思合并的额外约束，只在反思 pass 注入。 */
export const REFLECT_COMPRESSION_PROMPT = [
  '【反思合并】',
  '- 重新压缩已有摘要条目时，保留其中的不可再生信息，不要逐轮缩减。',
].join('\n');

/** 原始合法 ask 的处理约束，只在视图含待处理原始提问时注入。 */
export const ASK_COMPRESSION_PROMPT = [
  '【原始提问处理】',
  '- 原始合法 ask_user_question 在 getHistory 中以 <ask-user-question index="N"> 展示，每题为 q:问题、o1:选项一、o2:选项二等及 a:回答；选项包含 label 与 description，无选项题省略 oN 行。',
  '- 每个原始提问必须二选一：直接用 compressHistory 压成普通 assistant 摘要；或者保留 ask 标签并用 rewriteAskUserQuestion 重写 q/a。不能原样跳过。',
  '- 直接压缩：仅在明确判断该提问与后续任务无关时执行；首次覆盖会被阻止一次，重新思考后再次调用才执行。不确定或相关时走保留重写路径。',
  '- 保留重写：先用 getHistory 查看该提问及全部选项，收到返回结果后的下一轮再调用 rewriteAskUserQuestion({index, qa:[{ordinal:1,q:"问题",a:"回答"},...]})，不要与查看同轮提交；ordinal 从 1 开始，按原题序提交全部题，不增删、不重复。',
  '- q/a 均可忠实精炼，保留语境与用户真实意图。将回答中对选项的编号、标签等引用展开为自足表述；产物仅有 q:/a:，不能保留 oN 选项列表或 options 字段。',
  '- 空答案明确为 (未回答)，不得补造用户决定。仅提交纯文本 q/a，不自行拼接 XML 或 CDATA 包裹。',
  '- 允许切换路径；最终成功的直接压缩覆盖优先，已覆盖的 ask 不能再次重写。history 块中的 ask 已处理，不需重写。',
  '- completeCompression 仅在每个原始合法 ask 已成功直接压缩或重写后完成；若返回待处理 index，请处理后再次调用。',
].join('\n');

/** 模型输出纯文本（无工具调用）时追加的提醒消息文本。 */
export const COMPRESSION_NUDGE_TEXT =
  '请通过工具执行压缩：用 getHistory 查看区间条目，用 compressHistory 压缩 assistant 条目，完成后调用 completeCompression。不要输出与工具调用无关的文本。';

/** 输出被 max-tokens 截断且无工具调用时追加的提醒消息文本。 */
export const TRUNCATION_NUDGE_TEXT =
  '上一轮输出因长度上限被截断，其中的工具调用未被接收。请缩短思考，直接分批调用 compressHistory（每次覆盖较小区间），最后调用 completeCompression。';

/** 连续无工具调用、连续截断各自允许的最大轮数。 */
const MAX_CONSECUTIVE_FAILURES = 3;

/** 瞬时请求错误的连续最大重试次数。 */
const MAX_TRANSIENT_RETRIES = 3;

/** 逐轮请求统计：轮次（1 起）、该轮起止时间戳与耗时、该轮 token usage。 */
export type CompressionRoundStat = {
  /** 轮次（1 起）。 */
  round: number;
  /** 该轮请求开始时间（epoch 毫秒）。 */
  startedAt: number;
  /** 该轮请求耗时（毫秒）。 */
  durationMs: number;
  /** 该轮 token usage（提供方未报告时缺失）。 */
  usage?: TokenUsage;
};

/** 一次压缩循环的统计：循环起止时间戳、总耗时与逐轮请求统计。 */
export type CompressionStats = {
  /** 循环开始时间（epoch 毫秒）。 */
  startedAt: number;
  /** 循环结束时间（epoch 毫秒）。 */
  completedAt: number;
  /** 循环总耗时（毫秒）。 */
  durationMs: number;
  /** 逐轮请求统计（完成响应的轮次；流异常轮次不计入）。 */
  rounds: readonly CompressionRoundStat[];
};

/** 工具循环选项。 */
export type CompressionLoopOptions = {
  /** 压缩视图（工具数据源，观察或反思）。 */
  view: CompressionView;
  /** 压缩 pass（会话记录 label 标注用）。 */
  phase: 'observe' | 'reflect';
  /** 首条 user 消息文本（压缩指令 + start/end）。 */
  taskText: string;
  /** 摘要调用的路由目标。 */
  target: RoutedTarget;
  /** 单轮生成上限（LLM maxTokens）；undefined 不设置。 */
  maxTokens: number | undefined;
  /** 429 限流冷却毫秒数。 */
  rateLimitWaitMs: number;
  /** 是否在 getHistory 输出中省略 <reasoning> 参考条目（压缩指令同步省略其说明行）。 */
  skipReasoning: boolean;
  /** 步骤级日志开关。 */
  debug: boolean;
  /** 压缩请求的思考等级（已按目标模型校验）；undefined 用模型默认。 */
  reasoningEffort?: ReasoningEffortId;
  /** 原始消息字符数（与 OM 卡片口径一致）；缺省按视图条目估算。 */
  originalChars?: number;
  /** 是否重压缩（仅标记会话记录标题）；常规压缩缺省。 */
  retry?: boolean;
  /** 取消信号。 */
  signal?: AbortSignal;
};

/** 循环成功结果：最终 <history> 块 + 模型请求轮数 + 汇总 usage + 循环统计 + 会话记录子会话 id。 */
export type CompressionSuccess = {
  ok: true;
  /** 最终 <history> 块文本。 */
  text: string;
  /** 模型请求轮数（进入会话记录的 assistant 消息数）。 */
  rounds: number;
  /** 全部轮次 token usage 合计（无 usage 数据时缺失）。 */
  usage?: TokenUsage;
  /** 循环统计（起止时间戳、总耗时与逐轮请求统计）。 */
  stats: CompressionStats;
  /** 压缩会话记录子会话 id（落盘失败时缺失）。 */
  recordSessionId?: string;
};

/** 循环失败结果：最后一次错误 + 是否因 signal 中止 + 循环统计 + 会话记录子会话 id。 */
export type CompressionFailure = {
  ok: false;
  /** 最后一次错误（signal 中止时为 COMPACTION_ABORTED_ERROR）。 */
  error: string;
  /** 因 signal 中止而放弃。 */
  aborted: boolean;
  /** 循环统计（起止时间戳、总耗时与已完成轮次的请求统计）。 */
  stats: CompressionStats;
  /** 压缩会话记录（诊断）子会话 id（落盘失败时缺失）。 */
  recordSessionId?: string;
};

/** 循环结果（成功/失败二选一）。 */
export type CompressionOutcome = CompressionSuccess | CompressionFailure;

/** 视图原始消息字符数估算：非 reasoning 条目之和；工具调用条目的 text 已含参数与结果，不重复计入。 */
export function viewCharCount(view: CompressionView): number {
  return view.entries.reduce(
    (total, entry) => (entry.kind === 'reasoning' ? total : total + entry.text.length),
    0,
  );
}

/** 构造插件自产 user 消息（压缩指令/提醒；source 为插件自有 kind）。 */
function makePluginUserMessage(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: omSource(),
  });
}

/** 把工具执行结果封装为 tool-result 消息（回填到压缩会话）。 */
function toolResultOf(call: ToolCallBlock, result: ToolCallResult): Message {
  return createToolResultMessage({
    callId: call.id,
    content: [{ type: 'text', text: result.text }],
    isError: result.isError,
  });
}

/**
 * 把本轮已组装的部分 assistant 输出计入会话记录（error 终态时的诊断价值）。
 * 无任何文本/工具调用块（空流）时不追加。
 */
function pushPartialAssistant(
  assembler: BlockAssembler,
  messages: Message[],
  target: RoutedTarget,
): void {
  const blocks = assembler.blocks();
  if (blocks.length === 0) return;
  if (blocks.every((block) => block.type === 'text' && block.text.trim() === '')) return;
  messages.push(
    assembler.message({
      provider: target.provider,
      model: target.model,
    }),
  );
}

/** 累加两份 token usage（可选字段任一存在即求和保留）。 */
function addUsage(total: TokenUsage | undefined, add: TokenUsage): TokenUsage {
  if (total === undefined) return { ...add };
  const sum = (a?: number, b?: number): number | undefined =>
    a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
  const usage: TokenUsage = {
    inputTokens: total.inputTokens + add.inputTokens,
    outputTokens: total.outputTokens + add.outputTokens,
  };
  const cacheRead = sum(total.cacheReadTokens, add.cacheReadTokens);
  const cacheWrite = sum(total.cacheWriteTokens, add.cacheWriteTokens);
  const reasoning = sum(total.reasoningTokens, add.reasoningTokens);
  if (cacheRead !== undefined) usage.cacheReadTokens = cacheRead;
  if (cacheWrite !== undefined) usage.cacheWriteTokens = cacheWrite;
  if (reasoning !== undefined) usage.reasoningTokens = reasoning;
  return usage;
}

/** 是否为 429 限流失败（异常消息或终态 failure 载荷）。 */
function isRateLimitFailure(message: string, status?: number): boolean {
  return status === 429 || isRateLimitError(message);
}

/** 是否为可重试的瞬时失败：有 status 时按 5xx 判定，否则匹配 5xx 状态码或常见网络类错误文案。 */
export function isTransientFailure(message: string, status?: number): boolean {
  if (status !== undefined) return status >= 500 && status <= 599;
  return /\b5\d{2}\b|econnreset|etimedout|econnrefused|epipe|socket hang up|fetch failed|network|overloaded|timed? ?out/i.test(
    message,
  );
}

/** skipReasoning=true 时去掉视图中的 reasoning 条目（兑现 getHistory 不输出 reasoning 的契约）；否则原样返回。 */
export function withoutReasoning(view: CompressionView, skipReasoning: boolean): CompressionView {
  if (!skipReasoning) return view;
  return { ...view, entries: view.entries.filter((entry) => entry.kind !== 'reasoning') };
}

/**
 * 运行工具驱动的压缩循环：直到模型调用 completeCompression（成功）、连续 3 轮无
 * 工具调用、请求级错误或 signal 中止（失败）。成功与失败均落盘循环会话记录。
 */
export async function runCompressionLoop(
  ctx: Context,
  session: Session,
  options: CompressionLoopOptions,
): Promise<CompressionOutcome> {
  const logger = makeLogger(ctx, options.debug);
  const view = withoutReasoning(options.view, options.skipReasoning);
  const state = new CompressionState(view);
  const tools = state.hasPendingAsks
    ? [...COMPRESSION_TOOL_SCHEMAS, REWRITE_ASK_TOOL_SCHEMA]
    : COMPRESSION_TOOL_SCHEMAS;
  const system = [
    buildCompressionPrompt(options.skipReasoning),
    ...(options.phase === 'reflect' ? [REFLECT_COMPRESSION_PROMPT] : []),
    ...(state.hasPendingAsks ? [ASK_COMPRESSION_PROMPT] : []),
  ].join('\n\n');
  const messages: Message[] = [makePluginUserMessage(options.taskText)];
  let rounds = 0;
  let nudges = 0;
  let truncations = 0;
  let transientRetries = 0;
  /** 最后一个收到终态的请求的 finish 类型与输出 token 数（失败日志用）。 */
  let lastFinish: string | undefined;
  let lastOutputTokens: number | undefined;
  /** 仅落盘、不进入后续请求的消息（截断轮的 assistant 消息）。 */
  const omitted = new Set<Message>();
  let usage: TokenUsage | undefined;
  const startedAt = Date.now();
  const roundStats: CompressionRoundStat[] = [];
  /** 汇总当前循环统计（completedAt 取调用时刻；rounds 数组为引用共享）。 */
  const buildStats = (): CompressionStats => {
    const completedAt = Date.now();
    return { startedAt, completedAt, durationMs: completedAt - startedAt, rounds: roundStats };
  };
  const recordSessionId = async (
    success: boolean,
    stats: CompressionStats,
    resultChars?: number,
    failure?: CompressionFailureInfo,
  ): Promise<string | undefined> =>
    recordCompressionSession(ctx, session, {
      phase: options.phase,
      range: {
        ...(view.minIndex === undefined ? {} : { min: view.minIndex }),
        ...(view.maxIndex === undefined ? {} : { max: view.maxIndex }),
      },
      messages,
      stats,
      system,
      success,
      debug: options.debug,
      info: compressionInfo({
        target: options.target,
        originalChars: options.originalChars ?? viewCharCount(view),
        ...(options.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: options.reasoningEffort }),
        ...(resultChars === undefined ? {} : { resultChars }),
        ...(failure === undefined ? {} : { failure }),
      }),
      ...(options.retry === undefined ? {} : { retry: options.retry }),
    });
  const failWith = async (error: string, aborted: boolean): Promise<CompressionFailure> => {
    const stats = buildStats();
    const id = await recordSessionId(false, stats, undefined, {
      reason: error,
      ...(lastFinish === undefined ? {} : { finish: lastFinish }),
      ...(lastOutputTokens === undefined ? {} : { outputTokens: lastOutputTokens }),
    });
    return {
      ok: false,
      error,
      aborted,
      stats,
      ...(id === undefined ? {} : { recordSessionId: id }),
    };
  };
  logger.step(
    `压缩循环开始（${options.phase === 'reflect' ? '反思' : '观察'}，provider ${options.target.provider}，model ${options.target.model}，maxTokens ${
      options.maxTokens === undefined ? '未设置' : String(options.maxTokens)
    }）`,
  );
  /** 瞬时失败且未超重试额度时记入限流门并返回 true（调用方 continue 重试）。 */
  const retryTransient = (message: string, status?: number): boolean => {
    if (!isTransientFailure(message, status) || transientRetries >= MAX_TRANSIENT_RETRIES) {
      return false;
    }
    transientRetries += 1;
    noteRateLimit();
    logger.warn(
      `压缩循环请求瞬时失败（${message}），等待 ${options.rateLimitWaitMs}ms 后重试（${transientRetries}/${MAX_TRANSIENT_RETRIES}）`,
    );
    return true;
  };
  for (;;) {
    if (options.signal?.aborted) {
      logger.warn('压缩循环中止（signal 已中止），放弃本次压缩');
      return await failWith(COMPACTION_ABORTED_ERROR, true);
    }
    const gated = await gateRateLimit(options.rateLimitWaitMs, options.signal);
    if (!gated) {
      logger.warn('压缩循环中止（限流等待被 signal 中止），放弃本次压缩');
      return await failWith(COMPACTION_ABORTED_ERROR, true);
    }
    // 逐轮计时从限流等待门放行后开始：round durationMs 仅覆盖该轮模型请求
    const roundStartedAt = Date.now();
    const requestOptions: GenerateOptions = {
      provider: options.target.provider,
      model: options.target.model,
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      ...(options.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: options.reasoningEffort }),
      sessionId: session.id,
      purpose: 'compaction',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      system,
      messages: messages.filter((message) => !omitted.has(message)),
      tools,
    };
    const assembler = new BlockAssembler();
    state.markHistoryDelivered();
    try {
      for await (const chunk of ctx.llm.stream(requestOptions)) assembler.push(chunk);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isRateLimitFailure(message)) {
        noteRateLimit();
        logger.warn(`压缩循环触发限流（429），等待 ${options.rateLimitWaitMs}ms 后重试`);
        continue;
      }
      if (retryTransient(message)) continue;
      logger.warn(`压缩循环请求失败: ${message}`);
      return await failWith(message, false);
    }
    const finish = assembler.finish;
    lastFinish = finish.kind;
    lastOutputTokens = assembler.usage?.outputTokens;
    if (finish.kind === 'aborted') {
      logger.warn('压缩循环中止（流以 aborted 结束），放弃本次压缩');
      return await failWith(COMPACTION_ABORTED_ERROR, true);
    }
    if (finish.kind === 'error') {
      // failure 缺失时（非规范流）以 finish kind 兜底描述，不因读取 undefined 抛错
      const failureMessage =
        typeof finish.failure?.message === 'string' && finish.failure.message !== ''
          ? finish.failure.message
          : '流以 error 终态结束（无失败详情）';
      const failureStatus =
        typeof finish.failure?.status === 'number' ? finish.failure.status : undefined;
      if (isRateLimitFailure(failureMessage, failureStatus)) {
        noteRateLimit();
        logger.warn(`压缩循环触发限流（429），等待 ${options.rateLimitWaitMs}ms 后重试`);
        continue;
      }
      if (retryTransient(failureMessage, failureStatus)) continue;
      logger.warn(`压缩循环请求失败: ${failureMessage}`);
      // 已收集的部分输出（文本/工具调用）计入会话记录（诊断价值）
      pushPartialAssistant(assembler, messages, options.target);
      return await failWith(failureMessage, false);
    }
    transientRetries = 0;
    rounds += 1;
    if (assembler.usage !== undefined) usage = addUsage(usage, assembler.usage);
    roundStats.push({
      round: rounds,
      startedAt: roundStartedAt,
      durationMs: Date.now() - roundStartedAt,
      ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
    });
    const assistantMessage = assembler.message({
      provider: options.target.provider,
      model: options.target.model,
    });
    messages.push(assistantMessage);
    const calls = assembler
      .blocks()
      .filter((block): block is ToolCallBlock => block.type === 'tool-call');
    if (calls.length === 0) {
      if (finish.kind === 'max-tokens') {
        truncations += 1;
        if (truncations >= MAX_CONSECUTIVE_FAILURES) {
          const error = `模型连续 ${MAX_CONSECUTIVE_FAILURES} 轮输出被 max-tokens 截断，放弃本次压缩`;
          logger.warn(error);
          return await failWith(error, false);
        }
        logger.warn('模型输出被 max-tokens 截断且无工具调用，丢弃该轮输出并追加提醒后继续');
        omitted.add(assistantMessage);
        messages.push(makePluginUserMessage(TRUNCATION_NUDGE_TEXT));
        continue;
      }
      nudges += 1;
      if (nudges >= MAX_CONSECUTIVE_FAILURES) {
        const error = `模型连续 ${MAX_CONSECUTIVE_FAILURES} 轮未调用压缩工具，放弃本次压缩`;
        logger.warn(error);
        return await failWith(error, false);
      }
      logger.warn('模型未调用压缩工具（输出纯文本），追加提醒后继续');
      messages.push(makePluginUserMessage(COMPRESSION_NUDGE_TEXT));
      continue;
    }
    nudges = 0;
    truncations = 0;
    for (const call of calls) {
      messages.push(toolResultOf(call, state.executeCall(call.name, call.arguments)));
      // 仅实际完成时停止；被门禁拒绝后允许执行同轮后续调用。
      if (state.completed) break;
    }
    if (state.completed) {
      if (options.signal?.aborted) return await failWith(COMPACTION_ABORTED_ERROR, true);
      const text = state.buildFinalBlock();
      if (state.replacementCount === 0 && state.rewriteCount === 0) {
        logger.warn('压缩完成但未执行任何压缩替换（空提交）');
      }
      logger.info(
        `压缩循环完成（${rounds} 轮，${state.replacementCount} 次压缩替换，${state.rewriteCount} 条提问重写，输出 ${text.length} 字符）`,
      );
      const stats = buildStats();
      const id = await recordSessionId(true, stats, text.length);
      return {
        ok: true,
        text,
        rounds,
        stats,
        ...(usage === undefined ? {} : { usage }),
        ...(id === undefined ? {} : { recordSessionId: id }),
      };
    }
  }
}
