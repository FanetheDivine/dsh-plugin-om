/**
 * 两级自动压缩（观察/反思）与 compaction 生命周期提交。
 * 导出 estimateTextTokens / isPairBalancedAfter / computeCompressRange / historySection /
 * reflectPass / observePass / maybeCompress。
 *
 * - 反思：全部 <history> 块 token 合计 ≥ reflectThresholdTokens 时，摘要合并为一条
 * - 观察：净压力（上下文压力 − 已压缩块 token 合计 − 系统提示词 token 估算）≥ observeThresholdTokens 时，
 *   摘要未压缩消息为新 <history> 块并精确替换被压缩区间（旧块保留）
 * - 两级在 pre-step 阻塞串行执行（先反思后观察）；仅主会话生效；omEnabled=false 关闭
 * - 压缩边界：最后一个合法 <history> 块之后的消息视为未压缩，其前不重复压缩
 * - 摘要尝试全部耗尽时 pass 返回失败结果（携带最后一次尝试的实际报错），压缩流程
 *   向上传播，pre-step 据此拒绝本 step 中断当前 turn；signal 中止标记 aborted（不中断）
 * - 提交走宿主 compaction/* 生命周期事件（start 带 phase → summary → 替换消息 → end），
 *   失败补 end(error，实际报错)；替换消息 source 标记插件标识供 UI 认领
 */
import { scopeOf } from '@deepseek-ai/dsh-scope';
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt';
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt';
import { HISTORY_TAG, isPluginOwnedSource, PLUGIN_LABEL } from './constants.ts';
import { indexCompleteMessages } from './log-index.ts';
import type { PluginLogger } from './logger.ts';
import { makeLogger } from './logger.ts';
import {
  buildHistoryPrompt,
  parseHistoryEntries,
  renderMessages,
  runSummarySubagent,
} from './summarize.ts';
import type {
  Agent,
  CompactionId,
  CompactionStartPayload,
  CompactionSummaryPayload,
  Context,
  PluginConfig,
  Session,
  SessionEvent,
  TokenUsage,
  UserMessage,
} from './types.ts';
import { blocksToText, type RoutedTarget, routedTarget, textCharCount, uuid } from './utils.ts';

/** 压缩 pass 结果：failed=false 表示无需中断（成功、跳过或非摘要耗尽的局部失败）；failed=true 携带最后一次尝试的实际报错与是否因 signal 中止。 */
export type CompressPassResult =
  | { failed: false }
  | { failed: true; error: string; aborted: boolean };

/** 历史文本 token 估算：4 字符 ≈ 1 token（与宿主 dsh-token-meter 启发式一致）。 */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * 反思输入块引用的最大完整消息 index（解析全部条目取最大 end；无条目返回 -1）。
 * 反思输出必须覆盖输入引用的完整 index 区间（0..max），连续性校验据此约束。
 */
function reflectExpectedEnd(contextText: string): number {
  let max = -1;
  for (const e of parseHistoryEntries(contextText)) {
    const hi = e.kind === 'assistant' && e.end !== undefined ? e.end : (e.index ?? 0);
    if (hi > max) max = hi;
  }
  return max;
}

/**
 * 判定消息是否为本插件的压缩日志消息并提取日志文本（按 source 标记判断，兼容旧宿主
 * checkpoint 标记 'compact'）。仅当消息文本含 <history> 开标签时视为压缩日志，返回整段
 * 文本；其余返回 undefined。
 */
function historyTextOf(event: SessionEvent | undefined): string | undefined {
  if (event?.type !== 'user/message') return undefined;
  const source = event.data.source as { kind?: string; plugin?: string } | undefined;
  if (!isPluginOwnedSource(source)) return undefined;
  const text = blocksToText(event.data.content);
  const idx = text.indexOf(`<${HISTORY_TAG}`);
  if (idx === -1) return undefined;
  const rest = text.slice(idx + HISTORY_TAG.length + 1);
  if (!rest.startsWith('>') && !rest.startsWith(' tip=')) return undefined;
  return text;
}

/** 提取 <history> 块内文（去掉开/闭标签与首尾空白；非块文本原样返回）。 */
function historyInnerText(text: string): string {
  const closeTag = `</${HISTORY_TAG}>`;
  const close = text.lastIndexOf(closeTag);
  if (close === -1) return text;
  const open = text.indexOf(`<${HISTORY_TAG}`);
  if (open === -1) return text;
  const gt = text.indexOf('>', open);
  if (gt === -1 || gt >= close) return text;
  return text.slice(gt + 1, close).trim();
}

/**
 * 判定表层节点 seq 之后的切点是否 tool-call/result 配对平衡：按表层顺序折叠未闭合的
 * 工具调用数，处理到 seq 后计数为 0 即平衡（防止把 tool-call 与其结果切到两侧）。
 */
export function isPairBalancedAfter(session: Session, seq: number): boolean {
  let inProgress = 0;
  for (const node of session.surface.nodes) {
    const event = session.events[node];
    if (event?.type === 'assistant/message') {
      inProgress += event.data.message.content.filter((block) => block.type === 'tool-call').length;
    } else if (event?.type === 'tool/result') {
      inProgress -= 1;
    }
    if (node === seq) return inProgress === 0;
  }
  return false;
}

/**
 * 观察压缩区间：压缩边界后的首个表层节点 → 表层长度-1-tailCount（尾部保留 tailCount
 * 条不压缩）；区间终点回退到 tool-call/result 配对平衡点（不切段）。无可行区间返回
 * undefined。返回区间起止表层 seq 与被遮蔽 seq 列表。
 */
export function computeCompressRange(
  session: Session,
  tailCount: number,
): { start: number; end: number; shadowedSeqs: number[] } | undefined {
  const surface = [...session.surface.nodes];
  if (surface.length === 0) return undefined;
  const { boundarySeq } = historySection(session);
  // 区间起点 = 压缩边界在表层顺序中的后继第一条消息（替换块追加在日志末尾，
  // seq 大于被遮蔽消息，须按表层顺序而非 seq 比较取「边界之后」）
  const startIdx = boundarySeq === undefined ? 0 : surface.indexOf(boundarySeq) + 1;
  if (startIdx >= surface.length) return undefined;
  let endIdx = surface.length - 1 - tailCount;
  if (endIdx < startIdx) return undefined;
  while (endIdx >= startIdx) {
    const node = surface[endIdx];
    if (node === undefined || isPairBalancedAfter(session, node)) break;
    endIdx -= 1;
  }
  if (endIdx < startIdx) return undefined;
  const start = surface[startIdx];
  const end = surface[endIdx];
  if (start === undefined || end === undefined) return undefined;
  const shadowedSeqs = surface.slice(startIdx, endIdx + 1);
  return { start, end, shadowedSeqs };
}

/**
 * 压缩边界（historySection）：扫描表层全部节点，收集所有合法 <history> 压缩日志块
 * （内文 + seq，按表层顺序），并以最后一个块的 seq 作为压缩边界——边界之后的消息视为
 * 未压缩，其前（含边界自身）视为已压缩。无压缩日志时 blocks 为空、boundarySeq 为
 * undefined。
 */
export function historySection(session: Session): {
  blocks: Array<{ text: string; seq: number }>;
  boundarySeq: number | undefined;
} {
  const blocks: Array<{ text: string; seq: number }> = [];
  let boundarySeq: number | undefined;
  for (const seq of session.surface.nodes) {
    const text = historyTextOf(session.events[seq]);
    if (text === undefined) continue;
    blocks.push({ text, seq });
    boundarySeq = seq;
  }
  return { blocks, boundarySeq };
}

/** 当前打开中的 turn 号（最近 turn/start 且未被 turn/end 关闭）；无则 null。 */
function openTurnOf(session: Session): number | null {
  let turn: number | null = null;
  for (const event of session.events) {
    if (event.type === 'turn/start') turn = event.data.turn;
    else if (event.type === 'turn/end') turn = null;
  }
  return turn;
}

/** 生成宿主 compaction 生命周期 id（uuid 按宿主品牌类型 CompactionId 标注）。 */
function newCompactionId(): CompactionId {
  return uuid() as unknown as CompactionId;
}

/** compaction 生命周期共享数据（start/summary/end 以 compactionId 关联）。 */
type CompactionLifecycle = {
  compactionId: CompactionId;
  turn: number | null;
};

/** 追加 compaction/start（log-only；载荷带 phase 区分观察/反思），返回事件 seq。 */
function appendCompactionStart(
  session: Session,
  lifecycle: CompactionLifecycle,
  phase: 'observe' | 'reflect',
): number {
  const payload: CompactionStartPayload = {
    compactionId: lifecycle.compactionId,
    turn: lifecycle.turn,
    phase,
  };
  return session.append('compaction/start', payload).seq;
}

/**
 * 追加 compaction/summary（log-only，承担影子价格认领：紧随其后的替换消息消费 claim）。
 * summary 为完整合并后的 <history> 内文；usage 由摘要调用提取（无则省略）。
 */
function appendCompactionSummary(
  session: Session,
  data: {
    lifecycle: CompactionLifecycle;
    summary: string;
    shadowedRange: { start: number; end: number };
    shadowedSeqs: number[];
    shadowedTokenCount: number;
    /** 被压缩内容的字符数（UI 标题统计用）。 */
    shadowedCharCount: number;
    provider: string;
    model: string;
    /** 摘要请求的生成上限（undefined 表示未设置，载荷省略该字段）。 */
    maxTokens: number | undefined;
    /** 摘要重试次数（0 起）。 */
    attemptCount: number;
    usage?: TokenUsage;
  },
): number {
  const payload: CompactionSummaryPayload = {
    compactionId: data.lifecycle.compactionId,
    summary: [{ type: 'text', text: data.summary }],
    shadowedRange: data.shadowedRange,
    shadowedSeqs: data.shadowedSeqs,
    shadowedTokenCount: data.shadowedTokenCount,
    shadowedCharCount: data.shadowedCharCount,
    provider: data.provider,
    model: data.model,
    ...(data.maxTokens === undefined ? {} : { maxTokens: data.maxTokens }),
    attemptCount: data.attemptCount,
    ...(data.usage === undefined ? {} : { usage: data.usage }),
  };
  return session.append('compaction/summary', payload).seq;
}

/** 追加 compaction/end（log-only，结束生命周期；error 记录失败原因）。 */
function appendCompactionEnd(
  session: Session,
  lifecycle: CompactionLifecycle,
  error?: string,
): number {
  return session.append('compaction/end', {
    compactionId: lifecycle.compactionId,
    turn: lifecycle.turn,
    ...(error === undefined ? {} : { error }),
  }).seq;
}

/** 追加 <history> 压缩日志消息（surfaceOp 替换遮蔽区间，source 标记插件自产 + compactionId）。 */
function appendHistoryMessage(
  session: Session,
  content: string,
  sourceEventSeqs: number[],
  surfaceOp: { op: 'replace'; start: number; end: number },
  compactionId: CompactionId,
): void {
  const message = {
    id: uuid(),
    role: 'user',
    content: [{ type: 'text', text: content }],
    source: { kind: 'plugin', plugin: PLUGIN_LABEL, compactionId },
  } as unknown as UserMessage; // id 为品牌类型 MessageId，插件自产消息由 session.append 运行时校验
  session.append('user/message', message, { surfaceOp, sourceEventSeqs });
}

/**
 * 反思：全部 <history> 块 token 合计 ≥ reflectThresholdTokens 时，摘要调用把整个块
 * 区段合并替换为一条更紧凑的摘要。失败不产生部分替换；摘要尝试全部耗尽返回
 * 失败结果（error = 最后一次尝试的实际报错/具体问题）。
 */
export async function reflectPass(
  ctx: Context,
  agent: Agent,
  config: Readonly<PluginConfig>,
  target: RoutedTarget,
  signal?: AbortSignal,
): Promise<CompressPassResult> {
  const session = agent.session;
  const logger = makeLogger(ctx, config.debug);
  logger.step(`反思检查（反思阈值 ${config.reflectThresholdTokens} tokens）`);
  const { blocks } = historySection(session);
  if (blocks.length === 0) {
    logger.step('反思：无 <history> 压缩日志，跳过');
    return { failed: false };
  }
  const threshold = config.reflectThresholdTokens;
  const tokens = blocks.reduce((total, block) => total + estimateTextTokens(block.text), 0);
  const shadowedCharCount = blocks.reduce(
    (total, block) => total + historyInnerText(block.text).length,
    0,
  );
  if (tokens < threshold) {
    logger.step(`反思：摘要 ${tokens} tokens < 阈值 ${threshold}，跳过`);
    return { failed: false };
  }
  logger.step(
    `反思：摘要 ${tokens} tokens ≥ 阈值 ${threshold}，触发精简合并（${blocks.length} 个块）`,
  );
  const first = blocks[0];
  const last = blocks[blocks.length - 1];
  if (first === undefined || last === undefined) {
    logger.step('反思：块区段缺失，跳过');
    return { failed: false };
  }
  const blockSeqs = blocks.map((block) => block.seq);
  const instruction = buildHistoryPrompt();
  const contextText = blocks.map((block) => block.text).join('\n');
  const expectedEnd = reflectExpectedEnd(contextText);
  const lifecycle: CompactionLifecycle = {
    compactionId: newCompactionId(),
    turn: openTurnOf(session),
  };
  try {
    logger.step('反思：追加 compaction/start（摘要调用前开启压缩中提示）');
    appendCompactionStart(session, lifecycle, 'reflect');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`反思压缩启动失败: ${message}`);
    return { failed: false };
  }
  const summaryResult = await runSummarySubagent(
    ctx,
    agent,
    instruction,
    contextText,
    config.compressMaxTokens,
    target,
    config.debug,
    signal,
    {
      maxAttempts: config.compressRetryCount + 1,
      expected: expectedEnd < 0 ? { start: 0 } : { start: 0, end: expectedEnd },
      rateLimitWaitMs: config.rateLimitWaitMs,
    },
  );
  if (!summaryResult.ok) {
    logger.warn(`反思：摘要调用失败（${summaryResult.error}），追加 compaction/end(error)`);
    try {
      appendCompactionEnd(session, lifecycle, summaryResult.error);
    } catch {
      /* end 追加失败忽略（start 已记录，日志仍可诊断） */
    }
    return { failed: true, error: summaryResult.error, aborted: summaryResult.aborted };
  }
  const report = summaryResult.text;
  try {
    logger.step('反思提交：追加 compaction/summary（影子价格认领）');
    const summarySeq = appendCompactionSummary(session, {
      lifecycle,
      summary: report,
      shadowedRange: { start: first.seq, end: last.seq },
      shadowedSeqs: blockSeqs,
      shadowedTokenCount: tokens,
      shadowedCharCount,
      provider: target.provider,
      model: target.model,
      maxTokens: config.compressMaxTokens,
      attemptCount: summaryResult.attemptCount - 1,
      ...(summaryResult.usage === undefined ? {} : { usage: summaryResult.usage }),
    });
    logger.step('反思提交：替换整个 <history> 块区段为合并摘要');
    appendHistoryMessage(
      session,
      report,
      [summarySeq, ...blockSeqs],
      {
        op: 'replace',
        start: first.seq,
        end: last.seq,
      },
      lifecycle.compactionId,
    );
    logger.step('反思提交：追加 compaction/end');
    appendCompactionEnd(session, lifecycle);
    logger.info(
      `反思完成（摘要 ${tokens} tokens ≥ 阈值 ${threshold}，合并 ${blocks.length} 个块为一条）`,
    );
    return { failed: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`反思提交失败: ${message}`);
    try {
      appendCompactionEnd(session, lifecycle, message);
    } catch {
      /* end 追加失败忽略（start 已记录，日志仍可诊断） */
    }
    // 提交失败为局部异常（摘要已成功）：记日志后继续本轮，不中断 turn
    return { failed: false };
  }
}

/**
 * 估算系统提示词 tokens：按 agent 作用域组装并渲染系统提示词，按长度/4 启发式计。
 * 宿主未提供 systemPrompt 服务（无 assemble）或组装/渲染失败时按 0 计——只影响
 * 观察触发时机（偏早触发），不产生错误。
 */
async function estimateSystemPromptTokens(
  ctx: Context,
  agent: Agent,
  logger: PluginLogger,
  signal?: AbortSignal,
): Promise<number> {
  const systemPrompt = ctx.systemPrompt;
  if (typeof systemPrompt?.assemble !== 'function') return 0;
  try {
    const agentCtx = (agent as { ctx?: Context }).ctx;
    const scope = agentCtx === undefined ? undefined : scopeOf(agentCtx);
    const assembleContext: AssembleContext = { agent };
    if (scope !== undefined) assembleContext.scope = scope;
    if (signal !== undefined) assembleContext.signal = signal;
    const assembly = await systemPrompt.assemble(assembleContext);
    return estimateTextTokens(renderPrompt(assembly));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`系统提示词 tokens 估算失败，按 0 计: ${message}`);
    return 0;
  }
}

/**
 * 观察：净压力 tokens（上下文压力 − 已压缩 <history> 块 token 合计 − 系统提示词
 * token 估算）≥ observeThresholdTokens 时，摘要调用把未压缩消息压缩为观察日志，
 * 追加到旧摘要并替换被压缩消息区间。失败不产生部分替换；摘要尝试全部耗尽返回
 * 失败结果（error = 最后一次尝试的实际报错/具体问题）。
 */
export async function observePass(
  ctx: Context,
  agent: Agent,
  config: Readonly<PluginConfig>,
  tailCount: number,
  target: RoutedTarget,
  signal?: AbortSignal,
): Promise<CompressPassResult> {
  const session = agent.session;
  const logger = makeLogger(ctx, config.debug);
  logger.step(
    `观察检查（观察阈值 ${config.observeThresholdTokens} tokens，尾部保留 ${tailCount} 条）`,
  );
  const threshold = config.observeThresholdTokens;
  const pressureTokens = ctx.tokenMeter.measure(session).totalTokens;
  const { blocks } = historySection(session);
  const historyTokens = blocks.reduce((total, block) => total + estimateTextTokens(block.text), 0);
  const systemTokens = await estimateSystemPromptTokens(ctx, agent, logger, signal);
  const netTokens = pressureTokens - historyTokens - systemTokens;
  if (netTokens < threshold) {
    logger.step(
      `观察：净压力 ${netTokens} tokens（上下文压力 ${pressureTokens} − 已压缩块 ${historyTokens} − 系统提示词 ${systemTokens}）< 阈值 ${threshold}，跳过`,
    );
    return { failed: false };
  }
  logger.step(
    `观察：净压力 ${netTokens} tokens（上下文压力 ${pressureTokens} − 已压缩块 ${historyTokens} − 系统提示词 ${systemTokens}）≥ 阈值 ${threshold}，触发压缩`,
  );
  const range = computeCompressRange(session, tailCount);
  if (!range) {
    logger.step('观察：无可行压缩区间（边界后消息过短或配对无法平衡），跳过');
    return { failed: false };
  }
  logger.step(
    `观察：压缩区间 [${range.start}..${range.end}]，遮蔽 ${range.shadowedSeqs.length} 个表层节点`,
  );
  const replaceSeqs = range.shadowedSeqs;
  const replaceStart = replaceSeqs[0];
  if (replaceStart === undefined) {
    logger.step('观察：区间内无新消息（全部为压缩日志块），跳过');
    return { failed: false };
  }
  const shadowedSet = new Set(replaceSeqs);
  const inRangeCms = indexCompleteMessages(session).filter((cm) =>
    cm.seqs.every((seq) => shadowedSet.has(seq)),
  );
  if (inRangeCms.length === 0) {
    logger.step('观察：区间内无完整消息，跳过');
    return { failed: false };
  }
  const startIndex = inRangeCms[0]?.index ?? 0;
  const endIndex = inRangeCms[inRangeCms.length - 1]?.index ?? startIndex;
  logger.step(
    `观察：保留旧块 ${blocks.length} 条，替换新消息 [${replaceSeqs[0]}..${range.end}]（${replaceSeqs.length} 条），尾部保留 ${tailCount} 条（不压缩、不进日志），新消息 index ${startIndex}..${endIndex}`,
  );
  const instruction = buildHistoryPrompt();
  const contextText = renderMessages(session, replaceSeqs);
  const lifecycle: CompactionLifecycle = {
    compactionId: newCompactionId(),
    turn: openTurnOf(session),
  };
  try {
    logger.step('观察：追加 compaction/start（摘要调用前开启压缩中提示）');
    appendCompactionStart(session, lifecycle, 'observe');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`观察压缩启动失败: ${message}`);
    return { failed: false };
  }
  const summaryResult = await runSummarySubagent(
    ctx,
    agent,
    instruction,
    contextText,
    config.compressMaxTokens,
    target,
    config.debug,
    signal,
    {
      maxAttempts: config.compressRetryCount + 1,
      expected: { start: startIndex, end: endIndex },
      rateLimitWaitMs: config.rateLimitWaitMs,
    },
  );
  if (!summaryResult.ok) {
    logger.warn(`观察：摘要调用失败（${summaryResult.error}），追加 compaction/end(error)`);
    try {
      appendCompactionEnd(session, lifecycle, summaryResult.error);
    } catch {
      /* end 追加失败忽略（start 已记录，日志仍可诊断） */
    }
    return { failed: true, error: summaryResult.error, aborted: summaryResult.aborted };
  }
  const report = summaryResult.text;
  const attemptCount = summaryResult.attemptCount - 1;
  const usage = summaryResult.usage;
  const shadowedTokenCount = replaceSeqs.reduce((total, seq) => {
    const event = session.events[seq];
    const message = event ? session.deriveEventMessage(event) : null;
    return total + (message ? ctx.tokenMeter.estimateMessage(message) : 0);
  }, 0);
  const shadowedCharCount = replaceSeqs.reduce((total, seq) => {
    const event = session.events[seq];
    const message = event ? session.deriveEventMessage(event) : null;
    return total + (message ? textCharCount(message) : 0);
  }, 0);
  try {
    logger.step('观察提交：追加 compaction/summary（影子价格认领）');
    const summarySeq = appendCompactionSummary(session, {
      lifecycle,
      summary: report,
      shadowedRange: { start: replaceStart, end: range.end },
      shadowedSeqs: replaceSeqs,
      shadowedTokenCount,
      shadowedCharCount,
      provider: target.provider,
      model: target.model,
      maxTokens: config.compressMaxTokens,
      attemptCount,
      ...(usage === undefined ? {} : { usage }),
    });
    logger.step('观察提交：替换被压缩新消息区间为 <history>（旧块保留）');
    appendHistoryMessage(
      session,
      report,
      [summarySeq, ...replaceSeqs],
      {
        op: 'replace',
        start: replaceStart,
        end: range.end,
      },
      lifecycle.compactionId,
    );
    logger.step('观察提交：追加 compaction/end');
    appendCompactionEnd(session, lifecycle);
    logger.info(
      `观察压缩完成（净压力 ${netTokens} tokens（上下文压力 ${pressureTokens} − 已压缩块 ${historyTokens}）≥ 阈值 ${threshold}，替换 ${replaceSeqs.length} 个表层节点，约 ${shadowedTokenCount} tokens）`,
    );
    return { failed: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`观察压缩提交失败: ${message}`);
    try {
      appendCompactionEnd(session, lifecycle, message);
    } catch {
      /* end 追加失败忽略（start 已记录，日志仍可诊断） */
    }
    // 提交失败为局部异常（摘要已成功）：记日志后继续本轮，不中断 turn
    return { failed: false };
  }
}

/**
 * 压力检查 + 两级压缩入口：先反思后观察，pre-step 阻塞串行执行；仅主会话生效。
 * 反思摘要耗尽失败时直接返回失败结果（观察无需继续，本轮将被拒绝）；观察失败同样
 * 传播失败结果，由 pre-step 拒绝本 step 中断当前 turn。
 */
export async function maybeCompress(
  ctx: Context,
  agent: Agent,
  config: Readonly<PluginConfig>,
  signal?: AbortSignal,
): Promise<CompressPassResult> {
  const session = agent.session;
  const logger = makeLogger(ctx, config.debug);
  if (!config.omEnabled) {
    logger.step('omEnabled=false，跳过压缩');
    return { failed: false };
  }
  const target = routedTarget(session);
  if (target === undefined) {
    logger.step('会话未路由（无 provider/model），跳过压缩');
    return { failed: false };
  }
  logger.step(`会话路由：provider ${target.provider}，model ${target.model}`);
  const tailCount = config.tailMessageCount;
  logger.step('反思 pass 开始');
  const reflect = await reflectPass(ctx, agent, config, target, signal);
  if (reflect.failed) {
    logger.step('反思 pass 失败（本轮将被拒绝），跳过观察 pass');
    return reflect;
  }
  logger.step('反思 pass 结束，观察 pass 开始');
  const observe = await observePass(ctx, agent, config, tailCount, target, signal);
  logger.step('观察 pass 结束，压缩流程完成');
  return observe;
}
