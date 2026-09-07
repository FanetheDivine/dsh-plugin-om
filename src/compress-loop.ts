/**
 * 工具驱动的压缩循环：以新会话方式直连 ctx.llm.stream()，模型通过 getHistory /
 * compressHistory / completeCompression 三个工具完成压缩，替代直出 <history> 块。
 * 导出 runCompressionLoop / buildCompressionPrompt / buildCompressionTaskText /
 * CompressionLoopOptions / CompressionOutcome / COMPRESSION_NUDGE_TEXT。
 *
 * - 首条 user 消息仅含压缩指令与 start/end 区间（buildCompressionTaskText），不含
 *   历史消息内容；共享压缩提示词作为 system
 * - 每轮请求携带压缩工具 schemas（purpose='compaction'，maxTokens 沿用配置）；流经
 *   BlockAssembler 组装为 assistant 消息，工具执行结果以 tool-result 消息回填
 * - completeCompression 调用后立即停止（同轮后续工具调用不再执行），最终 <history>
 *   块由 CompressionState 构建，全程无需整块校验
 * - 模型输出纯文本（无工具调用）时追加提醒消息继续，连续 2 轮仍无工具调用判失败
 * - 429 限流走全局限流等待门（gateRateLimit / noteRateLimit）；其余请求级错误依赖
 *   dsh 运行时重试，插件不做整体重试，错误直接判失败
 * - signal 中止标记 aborted；token usage 汇总全部轮次
 * - 成功与失败均把循环消息组原样落盘为子会话（recordCompressionSession），成功记
 *   录 sessionId 于日志，失败记录作为诊断子会话 id 向上传播
 */

import {
  BlockAssembler,
  createToolResultMessage,
  type GenerateOptions,
  type Message,
  type TokenUsage,
  type ToolCallBlock,
  type UserMessage,
} from '@deepseek-ai/dsh-llm';
import { recordCompressionSession } from './compaction-log.ts';
import {
  COMPRESSION_TOOL_SCHEMAS,
  CompressionState,
  type ToolCallResult,
} from './compress-tools.ts';
import type { CompressionView } from './compress-view.ts';
import {
  COMPACTION_ABORTED_ERROR,
  COMPLETE_MESSAGE_DEFINITION,
  PLUGIN_LABEL,
} from './constants.ts';
import { makeLogger } from './logger.ts';
import { gateRateLimit, isRateLimitError, noteRateLimit } from './rate-limit.ts';
import type { Context, Session } from './types.ts';
import { type RoutedTarget, uuid } from './utils.ts';

/**
 * 共享压缩提示词（观察/反思同一套）：完整消息定义、工具语义、压缩要求、skill 规则
 * 与提交方式。作为压缩会话的 system；skipReasoning=true 时省略 <reasoning> 说明行。
 */
export function buildCompressionPrompt(skipReasoning: boolean): string {
  const lines: string[] = [
    '压缩历史消息为摘要。你应当通过工具查看、压缩并完成提交。',
    '',
    `【完整消息定义】${COMPLETE_MESSAGE_DEFINITION}`,
    '',
    '【工具】',
    '- getHistory(option?: {start?, end?})：查看压缩区间内的历史条目。start/end 缺省为要求区间的第一个/最后一个完整消息 index，必须在要求区间内。返回压缩视图：已压缩内容以摘要条目呈现，区间切入已压缩块时返回整块，不带 <history> 包裹。',
    '- compressHistory(option?: {index?, start?, end?, content})：把 index 单条或 start..end 连续区间的 assistant 类条目替换为 content 摘要（纯文本）。index 与 start/end 二选一，start==end 等同 index。区间不得覆盖用户消息或系统消息；与已有替换区间部分重叠会被拒绝，完全包含则覆盖。',
    '- completeCompression()：全部压缩完成后调用，立即结束。',
    '',
    '【压缩要求】',
    '- 先用 getHistory 查看区间内容，再划分模块分批压缩；用户消息与系统消息不可压缩、保持原样，无需处理。',
    ...(skipReasoning ? [] : ['- <reasoning> 仅作压缩参考，不进产物。']),
    '- 将具有关联性的 assistant 消息按内在逻辑连贯性划分为连续模块，聚合为区间压缩（start..end）',
    '- 单条重要的完整消息以 index 单独压缩',
    '- 压缩后的 assistant 消息内，应当描述**行为逻辑**，强调关键的**结论、产出和任务**；涉及到的具体文件保留完整路径',
    '- 摘要粒度越往后越细：靠近末尾（最近）的消息保留更多细节，开头（较早）的消息简写。',
    '- 加载的 skill 属于关键信息。仅在你明确判断该 skill 与后续任务无关时，压缩它；如果该 skill 与后续任务相关，或者你无法判断，不要压缩，**保持原文**。',
    '- 未压缩的条目将原样保留；宁可保留也不要强行压缩不确定的内容。',
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

/** 模型输出纯文本（无工具调用）时追加的提醒消息文本。 */
export const COMPRESSION_NUDGE_TEXT =
  '请通过工具执行压缩：用 getHistory 查看区间条目，用 compressHistory 压缩 assistant 条目，完成后调用 completeCompression。不要输出与工具调用无关的文本。';

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
  /** 取消信号。 */
  signal?: AbortSignal;
};

/** 循环成功结果：最终 <history> 块 + 模型请求轮数 + 汇总 usage + 会话记录子会话 id。 */
export type CompressionSuccess = {
  ok: true;
  /** 最终 <history> 块文本。 */
  text: string;
  /** 模型请求轮数（进入会话记录的 assistant 消息数）。 */
  rounds: number;
  /** 全部轮次 token usage 合计（无 usage 数据时缺失）。 */
  usage?: TokenUsage;
  /** 压缩会话记录子会话 id（落盘失败时缺失）。 */
  recordSessionId?: string;
};

/** 循环失败结果：最后一次错误 + 是否因 signal 中止 + 会话记录子会话 id。 */
export type CompressionFailure = {
  ok: false;
  /** 最后一次错误（signal 中止时为 COMPACTION_ABORTED_ERROR）。 */
  error: string;
  /** 因 signal 中止而放弃。 */
  aborted: boolean;
  /** 压缩会话记录（诊断）子会话 id（落盘失败时缺失）。 */
  recordSessionId?: string;
};

/** 循环结果（成功/失败二选一）。 */
export type CompressionOutcome = CompressionSuccess | CompressionFailure;

/** 构造插件自产 user 消息（压缩指令/提醒；id 为品牌类型 MessageId）。 */
function makePluginUserMessage(text: string): UserMessage {
  return {
    id: uuid() as unknown as UserMessage['id'],
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: PLUGIN_LABEL },
  } as unknown as UserMessage;
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
      kind: 'model',
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

/**
 * 运行工具驱动的压缩循环：直到模型调用 completeCompression（成功）、连续 2 轮无
 * 工具调用、请求级错误或 signal 中止（失败）。成功与失败均落盘循环会话记录。
 */
export async function runCompressionLoop(
  ctx: Context,
  session: Session,
  options: CompressionLoopOptions,
): Promise<CompressionOutcome> {
  const logger = makeLogger(ctx, options.debug);
  const state = new CompressionState(options.view);
  const messages: Message[] = [makePluginUserMessage(options.taskText)];
  let rounds = 0;
  let nudges = 0;
  let usage: TokenUsage | undefined;
  const recordSessionId = async (success: boolean): Promise<string | undefined> =>
    recordCompressionSession(ctx, session, {
      phase: options.phase,
      target: options.target,
      messages,
      rounds,
      success,
      debug: options.debug,
    });
  const failWith = async (error: string, aborted: boolean): Promise<CompressionFailure> => {
    const id = await recordSessionId(false);
    return { ok: false, error, aborted, ...(id === undefined ? {} : { recordSessionId: id }) };
  };
  logger.step(
    `压缩循环开始（${options.phase === 'reflect' ? '反思' : '观察'}，provider ${options.target.provider}，model ${options.target.model}，maxTokens ${
      options.maxTokens === undefined ? '未设置' : String(options.maxTokens)
    }）`,
  );
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
    const requestOptions: GenerateOptions = {
      provider: options.target.provider,
      model: options.target.model,
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      sessionId: session.id,
      purpose: 'compaction',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      system: buildCompressionPrompt(options.skipReasoning),
      messages: [...messages],
      tools: COMPRESSION_TOOL_SCHEMAS,
    };
    const assembler = new BlockAssembler();
    try {
      for await (const chunk of ctx.llm.stream(requestOptions)) assembler.push(chunk);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isRateLimitFailure(message)) {
        noteRateLimit();
        logger.warn(`压缩循环触发限流（429），等待 ${options.rateLimitWaitMs}ms 后重试`);
        continue;
      }
      logger.warn(`压缩循环请求失败: ${message}`);
      return await failWith(message, false);
    }
    const finish = assembler.finish;
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
      logger.warn(`压缩循环请求失败: ${failureMessage}`);
      // 已收集的部分输出（文本/工具调用）计入会话记录（诊断价值）
      pushPartialAssistant(assembler, messages, options.target);
      return await failWith(failureMessage, false);
    }
    rounds += 1;
    if (assembler.usage !== undefined) usage = addUsage(usage, assembler.usage);
    const assistantMessage = assembler.message({
      kind: 'model',
      provider: options.target.provider,
      model: options.target.model,
    });
    messages.push(assistantMessage);
    const calls = assembler
      .blocks()
      .filter((block): block is ToolCallBlock => block.type === 'tool-call');
    if (calls.length === 0) {
      nudges += 1;
      if (nudges >= 2) {
        const error = '模型连续 2 轮未调用压缩工具，放弃本次压缩';
        logger.warn(error);
        return await failWith(error, false);
      }
      logger.warn('模型未调用压缩工具（输出纯文本），追加提醒后继续');
      messages.push(makePluginUserMessage(COMPRESSION_NUDGE_TEXT));
      continue;
    }
    nudges = 0;
    let completed = false;
    for (const call of calls) {
      if (call.name === 'completeCompression') {
        messages.push(toolResultOf(call, state.complete()));
        completed = true;
        // completeCompression 调用后立即停止：同轮后续工具调用不再执行
        break;
      }
      messages.push(toolResultOf(call, state.executeCall(call.name, call.arguments)));
    }
    if (completed) {
      const text = state.buildFinalBlock();
      if (state.replacementCount === 0) {
        logger.warn('压缩完成但未执行任何压缩替换（空提交）');
      }
      logger.info(
        `压缩循环完成（${rounds} 轮，${state.replacementCount} 次压缩替换，输出 ${text.length} 字符）`,
      );
      const id = await recordSessionId(true);
      return {
        ok: true,
        text,
        rounds,
        ...(usage === undefined ? {} : { usage }),
        ...(id === undefined ? {} : { recordSessionId: id }),
      };
    }
  }
}
