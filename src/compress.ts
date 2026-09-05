/**
 * 两级自动压缩（观察/反思）与 compaction 生命周期提交。
 * 导出 estimateTextTokens / isPairBalancedAfter / computeCompressRange / historySection /
 * findObservePending / reflectPass / observePass / maybeCompress。
 *
 * - 摘要生成走工具驱动的压缩循环（compress-loop.ts runCompressionLoop）：首条 user
 *   消息仅含压缩指令与 start/end 区间，模型经 getHistory / compressHistory /
 *   completeCompression 工具完成压缩；最终 <history> 块由插件从视图与替换记录构建，
 *   全程无需整块校验
 * - 反思：全部 <history> 块 token 合计 ≥ reflectThresholdTokens 时，把全部块条目作为
 *   压缩视图重新压缩合并（视图无条目时跳过，如全部为不可解析的历史遗留块）
 * - 观察（触发 → 待定 → 延迟执行）：净压力（上下文压力 − 已压缩块 token 合计 − 系统提示词
 *   token 估算 − 工具定义 token 估算）首次 ≥ observeThresholdTokens 时记录待定标记
 *   （触发点 = 当时的最后一条完整消息 index），本次不压缩；待定后新增完整消息数 ≥
 *   tailMessageCount 时，把压缩边界至触发点的全部消息作为压缩视图替换为新 <history>
 *   块（旧块保留），等待期间的新消息成为下一轮未压缩尾部（延迟窗口内压力允许
 *   短暂超阈值）；tailMessageCount=0 时触发当轮直接执行（不落待定标记）
 * - 待定标记以 log-only om/observe-pending / om/observe-invalidate 事件持久化在会话
 *   日志中（重启后从日志恢复）；压缩失败保留待定，下个 pre-step 直接重试执行
 * - 两级在 pre-step 阻塞串行执行（先反思后观察）；仅主会话生效；omEnabled=false 关闭
 * - 压缩边界：最后一个合法 <history> 块之后的消息视为未压缩，其前不重复压缩
 * - 压缩循环最终失败（连续无工具调用 / 请求级错误）时 pass 返回失败结果（携带最后一次
 *   错误），压缩流程向上传播，pre-step 据此拒绝本 step 中断当前 turn；signal 中止标记
 *   aborted（不中断）；成功与失败均落盘压缩会话记录子会话（失败时其 id 随结果传播为
 *   诊断子会话 id）
 * - 提交走宿主 compaction/* 生命周期事件（start 带 phase → summary → 替换消息 → end），
 *   失败补 end(error，实际报错 + 诊断子会话 sessionId)；替换消息 source 标记插件标识供 UI 认领
 * - 挂载失败类问题（systemPrompt/tokenMeter 服务异常）始终 console 到外部进程，并追加
 *   log-only om/warning 事件（客户端渲染功能降级警告行，每会话同一问题至多一次）；
 *   辅助估算的普通运行时报错仅记日志。降级与报错都不阻塞压缩（tokenMeter 压力数据
 *   缺失时本轮跳过观察）
 */
import { scopeOf } from '@deepseek-ai/dsh-scope';
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt';
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt';
import {
  buildCompressionTaskText,
  type CompressionLoopOptions,
  type CompressionOutcome,
  runCompressionLoop,
} from './compress-loop.ts';
import { buildObserveView, buildReflectView } from './compress-view.ts';
import { HISTORY_TAG, isPluginOwnedSource, PLUGIN_LABEL } from './constants.ts';
import { reportDegrade } from './degrade.ts';
import { indexCompleteMessages, surfaceIndexOf } from './log-index.ts';
import type { PluginLogger } from './logger.ts';
import { makeLogger } from './logger.ts';
import type {
  Agent,
  CompactionEndPayload,
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

/**
 * 压缩 pass 结果：failed=false 表示无需中断（成功、跳过或非最终的局部失败）；
 * failed=true 携带最后一次错误、是否因 signal 中止与诊断子会话 id（压缩会话记录
 * 子会话；落盘失败时缺失）。
 */
export type CompressPassResult =
  | { failed: false }
  | { failed: true; error: string; aborted: boolean; diagnosticSessionId?: string };

/** 历史文本 token 估算：4 字符 ≈ 1 token（与宿主 dsh-token-meter 启发式一致）。 */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * 运行压缩循环并归一化结果：失败统一追加 compaction/end(error)（携带诊断子会话 id），
 * 成功记会话记录日志；返回循环结果（成功时由调用方提交）。
 */
async function runPassLoop(
  ctx: Context,
  session: Session,
  lifecycle: CompactionLifecycle,
  options: CompressionLoopOptions,
  logger: PluginLogger,
  phase: 'observe' | 'reflect',
): Promise<CompressionOutcome> {
  const outcome = await runCompressionLoop(ctx, session, options);
  if (!outcome.ok) {
    logger.warn(
      `${phase === 'reflect' ? '反思' : '观察'}：压缩循环失败（${outcome.error}），诊断子会话 ${outcome.recordSessionId ?? '未落盘'}，追加 compaction/end(error)`,
    );
    try {
      appendCompactionEnd(session, lifecycle, outcome.error, outcome.recordSessionId);
    } catch {
      /* end 追加失败忽略（start 已记录，日志仍可诊断） */
    }
    return outcome;
  }
  if (outcome.recordSessionId !== undefined) {
    logger.step(`压缩会话记录子会话 ${outcome.recordSessionId}`);
  }
  return outcome;
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
 * 观察压缩区间：压缩边界后的首个表层节点 → 触发点完整消息（endMessageIndex）对应的
 * 表层终点（取该完整消息最后一个事件 seq 在表层中的位置）；区间终点回退到
 * tool-call/result 配对平衡点（不切段）。触发点完整消息不存在或其事件已不在表层
 * （被后续压缩遮蔽）时返回 undefined。返回区间起止表层 seq 与被遮蔽 seq 列表。
 */
export function computeCompressRange(
  session: Session,
  endMessageIndex: number,
): { start: number; end: number; shadowedSeqs: number[] } | undefined {
  const surface = [...session.surface.nodes];
  if (surface.length === 0) return undefined;
  const { boundarySeq } = historySection(session);
  // 区间起点 = 压缩边界在表层顺序中的后继第一条消息（替换块追加在日志末尾，
  // seq 大于被遮蔽消息，须按表层顺序而非 seq 比较取「边界之后」）
  const startIdx = boundarySeq === undefined ? 0 : surface.indexOf(boundarySeq) + 1;
  if (startIdx >= surface.length) return undefined;
  const target = indexCompleteMessages(session).find((cm) => cm.index === endMessageIndex);
  if (target === undefined) return undefined;
  // 完整消息可能含多个事件（toolcall = 调用 + 结果）：取最后一个仍在表层的 seq 定位终点
  let endIdx = -1;
  for (let i = target.seqs.length - 1; i >= 0; i -= 1) {
    const seq = target.seqs[i];
    if (seq === undefined) continue;
    endIdx = surfaceIndexOf(surface, seq);
    if (endIdx !== -1) break;
  }
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

/**
 * 查找当前活跃的观察压缩待定标记：按日志顺序取最后一条 om/observe-pending，其后须无
 * 引用它的 om/observe-invalidate（已失效），且其后的压缩边界 seq 不大于标记 seq（边界
 * 后移说明标记期间已发生过压缩，标记过期——兜底「执行成功但失效标记未写出」的崩溃
 * 窗口）。无活跃标记返回 undefined。
 */
export function findObservePending(
  session: Session,
): { seq: number; triggerMessageIndex: number } | undefined {
  let pending: { seq: number; triggerMessageIndex: number } | undefined;
  for (let seq = 0; seq < session.events.length; seq += 1) {
    const event = session.events[seq];
    if (!event) continue;
    if (event.type === 'om/observe-pending') {
      pending = { seq, triggerMessageIndex: event.data.triggerMessageIndex };
    } else if (
      event.type === 'om/observe-invalidate' &&
      pending !== undefined &&
      event.data.pendingSeq === pending.seq
    ) {
      pending = undefined;
    }
  }
  if (pending === undefined) return undefined;
  const { boundarySeq } = historySection(session);
  if (boundarySeq !== undefined && boundarySeq > pending.seq) return undefined;
  return pending;
}

/** 追加观察压缩待定标记（log-only）：记录触发点完整消息 index，返回事件 seq。 */
function appendObservePending(session: Session, triggerMessageIndex: number): number {
  return session.append('om/observe-pending', { key: 'observe', triggerMessageIndex }).seq;
}

/** 追加观察压缩待定失效标记（log-only）：声明指定 pending 已失效，返回事件 seq。 */
function appendObserveInvalidate(session: Session, pendingSeq: number): number {
  return session.append('om/observe-invalidate', { key: 'observe', pendingSeq }).seq;
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

/**
 * 追加 compaction/end（log-only，结束生命周期；error 记录失败原因，
 * diagnosticSessionId 记录最终失败时的诊断子会话 id）。
 */
function appendCompactionEnd(
  session: Session,
  lifecycle: CompactionLifecycle,
  error?: string,
  diagnosticSessionId?: string,
): number {
  const payload: CompactionEndPayload = {
    compactionId: lifecycle.compactionId,
    turn: lifecycle.turn,
    ...(error === undefined ? {} : { error }),
    ...(diagnosticSessionId === undefined ? {} : { diagnosticSessionId }),
  };
  return session.append('compaction/end', payload).seq;
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
 * 反思：全部 <history> 块 token 合计 ≥ reflectThresholdTokens 时，把全部块内条目作为
 * 压缩视图送入工具压缩循环，整个块区段合并替换为一条更紧凑的摘要。视图无条目（全部
 * 为不可解析的历史遗留块）时跳过。失败不产生部分替换；最终失败返回失败结果
 * （error = 最后一次错误）。
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
  const view = buildReflectView(blocks);
  if (view.minIndex === undefined || view.maxIndex === undefined) {
    logger.step('反思：块内无可定位条目（历史遗留块），跳过');
    return { failed: false };
  }
  const blockSeqs = blocks.map((block) => block.seq);
  const lifecycle: CompactionLifecycle = {
    compactionId: newCompactionId(),
    turn: openTurnOf(session),
  };
  try {
    logger.step('反思：追加 compaction/start（压缩循环前开启压缩中提示）');
    appendCompactionStart(session, lifecycle, 'reflect');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`反思压缩启动失败: ${message}`);
    return { failed: false };
  }
  const summaryResult = await runPassLoop(
    ctx,
    session,
    lifecycle,
    {
      view,
      phase: 'reflect',
      taskText: buildCompressionTaskText('reflect', view.minIndex, view.maxIndex),
      target,
      maxTokens: config.compressMaxTokens,
      rateLimitWaitMs: config.rateLimitWaitMs,
      debug: config.debug,
      ...(signal === undefined ? {} : { signal }),
    } satisfies CompressionLoopOptions,
    logger,
    'reflect',
  );
  if (!summaryResult.ok) {
    return {
      failed: true,
      error: summaryResult.error,
      aborted: summaryResult.aborted,
      ...(summaryResult.recordSessionId === undefined
        ? {}
        : { diagnosticSessionId: summaryResult.recordSessionId }),
    };
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
      attemptCount: summaryResult.rounds,
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
    // 提交失败为局部异常（压缩已成功）：记日志后继续本轮，不中断 turn
    return { failed: false };
  }
}

/**
 * 估算系统提示词 tokens：按 agent 作用域组装并渲染系统提示词，按长度/4 启发式计。
 * systemPrompt 服务经 ctx.get 容错读取（ctx 属性访问在服务未挂载时抛错）；服务缺失
 * 或组装/渲染失败时按 0 计——只影响观察触发时机（偏早触发），不阻塞压缩。
 * 服务缺失属挂载失败：console 外部 + om/warning 事件每会话报告一次；组装失败仅记日志。
 */
async function estimateSystemPromptTokens(
  ctx: Context,
  agent: Agent,
  logger: PluginLogger,
  signal?: AbortSignal,
): Promise<number> {
  // 服务未挂载时属性访问抛 "cannot get property ... without inject"，必须 ctx.get 容错读取
  const systemPrompt = ctx.get('systemPrompt');
  if (systemPrompt === undefined || typeof systemPrompt.assemble !== 'function') {
    reportDegrade(agent.session, logger, 'systemPrompt-missing');
    return 0;
  }
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
 * 估算请求工具定义 tokens：按会话请求头 tools（assembled tool schemas）JSON 序列化
 * 长度/4 启发式计（与宿主 dsh-token-meter 对工具 schema 的启发式一致）。请求头读取
 * 失败或缺 tools 时按 0 计——只影响观察触发时机（偏早触发），不阻塞压缩。
 */
function estimateToolsTokens(session: Session, logger: PluginLogger): number {
  try {
    const header = session.requestHeader();
    if (header?.tools === undefined || header.tools.length === 0) return 0;
    return estimateTextTokens(JSON.stringify(header.tools));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`工具定义 tokens 估算失败，按 0 计: ${message}`);
    return 0;
  }
}

/**
 * 读取上下文压力 tokens（tokenMeter.measure 的 totalTokens）。tokenMeter 调用异常时
 * 记日志并报告降级（console 外部 + om/warning 每会话一次），返回 undefined——本轮
 * 跳过观察压缩（无压力数据不触发），不阻塞 turn。
 */
function measurePressureTokens(
  ctx: Context,
  session: Session,
  logger: PluginLogger,
): number | undefined {
  try {
    return ctx.tokenMeter.measure(session).totalTokens;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`上下文压力读取失败（tokenMeter.measure 抛错），本轮跳过观察压缩: ${message}`);
    reportDegrade(session, logger, 'tokenMeter-unavailable');
    return undefined;
  }
}

/**
 * 观察（触发 → 待定 → 延迟执行）：无活跃待定标记时测净压力 tokens（上下文压力 − 已压缩
 * <history> 块 token 合计 − 系统提示词 token 估算 − 工具定义 token 估算），首次 ≥
 * observeThresholdTokens 时记录待定标记（触发点 = 当时的最后一条完整消息 index），本次
 * 不压缩（tailMessageCount=0 当轮直接执行，不落待定标记）；已有待定标记时按新增完整
 * 消息数 ≥ tailMessageCount 决定执行，压缩区间截至触发点（新增消息成为新未压缩尾部，
 * 延迟窗口内压力允许短暂超阈值）。执行成功（或无可行区间）后写待定失效标记；压缩
 * 失败保留待定，下个 pre-step 直接重试执行。最终失败返回失败结果
 * （error = 最后一次错误）。
 */
export async function observePass(
  ctx: Context,
  agent: Agent,
  config: Readonly<PluginConfig>,
  waitCount: number,
  target: RoutedTarget,
  signal?: AbortSignal,
): Promise<CompressPassResult> {
  const session = agent.session;
  const logger = makeLogger(ctx, config.debug);
  logger.step(
    `观察检查（观察阈值 ${config.observeThresholdTokens} tokens，延迟等待 ${waitCount} 条完整消息）`,
  );
  const { blocks } = historySection(session);
  const pending = findObservePending(session);
  let triggerMessageIndex: number;
  let pendingSeq: number | undefined;
  let triggerNote: string;
  if (pending === undefined) {
    const threshold = config.observeThresholdTokens;
    const pressureTokens = measurePressureTokens(ctx, session, logger);
    if (pressureTokens === undefined) return { failed: false };
    const historyTokens = blocks.reduce(
      (total, block) => total + estimateTextTokens(block.text),
      0,
    );
    const systemTokens = await estimateSystemPromptTokens(ctx, agent, logger, signal);
    const toolsTokens = estimateToolsTokens(session, logger);
    const netTokens = pressureTokens - historyTokens - systemTokens - toolsTokens;
    if (netTokens < threshold) {
      logger.step(
        `观察：净压力 ${netTokens} tokens（上下文压力 ${pressureTokens} − 已压缩块 ${historyTokens} − 系统提示词 ${systemTokens} − 工具定义 ${toolsTokens}）< 阈值 ${threshold}，跳过`,
      );
      return { failed: false };
    }
    logger.step(
      `观察：净压力 ${netTokens} tokens（上下文压力 ${pressureTokens} − 已压缩块 ${historyTokens} − 系统提示词 ${systemTokens} − 工具定义 ${toolsTokens}）≥ 阈值 ${threshold}，触发压缩`,
    );
    const lastMessageIndex = indexCompleteMessages(session).length - 1;
    if (lastMessageIndex < 0) {
      logger.step('观察：会话尚无完整消息，跳过');
      return { failed: false };
    }
    triggerMessageIndex = lastMessageIndex;
    if (waitCount > 0) {
      // 记录待定标记（log-only），延迟 waitCount 条新完整消息后再执行压缩
      try {
        pendingSeq = appendObservePending(session, triggerMessageIndex);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`观察：待定标记追加失败，本轮跳过（下轮重新评估）: ${message}`);
        return { failed: false };
      }
      logger.step(
        `观察：记录待定标记（触发点完整消息 index ${triggerMessageIndex}），等待 ${waitCount} 条新完整消息后压缩`,
      );
      return { failed: false };
    }
    triggerNote = `触发点完整消息 index ${triggerMessageIndex}`;
  } else {
    const arrived = indexCompleteMessages(session).length - 1 - pending.triggerMessageIndex;
    if (arrived < waitCount) {
      logger.step(
        `观察：待定标记等待中（触发点完整消息 index ${pending.triggerMessageIndex}，新增 ${arrived}/${waitCount} 条），跳过`,
      );
      return { failed: false };
    }
    logger.step(
      `观察：待定标记延迟到期（触发点完整消息 index ${pending.triggerMessageIndex}，新增 ${arrived} ≥ ${waitCount} 条），执行压缩`,
    );
    triggerMessageIndex = pending.triggerMessageIndex;
    pendingSeq = pending.seq;
    triggerNote = `待定标记触发点完整消息 index ${pending.triggerMessageIndex}`;
  }
  // 执行压缩：区间 [压缩边界..触发点]；成功（或无可行区间）后写待定失效标记
  const clearPending = (): void => {
    if (pendingSeq === undefined) return;
    try {
      appendObserveInvalidate(session, pendingSeq);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`观察：待定失效标记追加失败: ${message}`);
    }
  };
  const range = computeCompressRange(session, triggerMessageIndex);
  if (!range) {
    logger.step(
      '观察：无可行压缩区间（边界后无消息、触发点已被压缩或配对无法平衡），清除待定标记视为完成',
    );
    clearPending();
    return { failed: false };
  }
  logger.step(
    `观察：压缩区间 [${range.start}..${range.end}]，遮蔽 ${range.shadowedSeqs.length} 个表层节点`,
  );
  const replaceSeqs = range.shadowedSeqs;
  const replaceStart = replaceSeqs[0];
  if (replaceStart === undefined) {
    logger.step('观察：区间内无新消息（全部为压缩日志块），清除待定标记视为完成');
    clearPending();
    return { failed: false };
  }
  const shadowedSet = new Set(replaceSeqs);
  const inRangeCms = indexCompleteMessages(session).filter((cm) =>
    cm.seqs.every((seq) => shadowedSet.has(seq)),
  );
  if (inRangeCms.length === 0) {
    logger.step('观察：区间内无完整消息，清除待定标记视为完成');
    clearPending();
    return { failed: false };
  }
  const view = buildObserveView(session, replaceSeqs);
  if (view.minIndex === undefined || view.maxIndex === undefined) {
    logger.step('观察：区间内无可定位条目，清除待定标记视为完成');
    clearPending();
    return { failed: false };
  }
  logger.step(
    `观察：保留旧块 ${blocks.length} 条，替换 [${replaceStart}..${range.end}]（${replaceSeqs.length} 个表层节点，压缩至${triggerNote}），视图区间 ${view.minIndex}..${view.maxIndex}`,
  );
  const lifecycle: CompactionLifecycle = {
    compactionId: newCompactionId(),
    turn: openTurnOf(session),
  };
  try {
    logger.step('观察：追加 compaction/start（压缩循环前开启压缩中提示）');
    appendCompactionStart(session, lifecycle, 'observe');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`观察压缩启动失败: ${message}`);
    return { failed: false };
  }
  const summaryResult = await runPassLoop(
    ctx,
    session,
    lifecycle,
    {
      view,
      phase: 'observe',
      taskText: buildCompressionTaskText('observe', view.minIndex, view.maxIndex),
      target,
      maxTokens: config.compressMaxTokens,
      rateLimitWaitMs: config.rateLimitWaitMs,
      debug: config.debug,
      ...(signal === undefined ? {} : { signal }),
    } satisfies CompressionLoopOptions,
    logger,
    'observe',
  );
  if (!summaryResult.ok) {
    // 压缩失败不清除待定标记：下个 pre-step 直接重试执行（无需重新触发与等待）
    return {
      failed: true,
      error: summaryResult.error,
      aborted: summaryResult.aborted,
      ...(summaryResult.recordSessionId === undefined
        ? {}
        : { diagnosticSessionId: summaryResult.recordSessionId }),
    };
  }
  const report = summaryResult.text;
  const usage = summaryResult.usage;
  // 单条消息计价失败按 0 计（tokenMeter 异常属挂载类降级：console 外部 + om/warning 每会话一次）
  const shadowedTokenCount = replaceSeqs.reduce((total, seq) => {
    const event = session.events[seq];
    const message = event ? session.deriveEventMessage(event) : null;
    let tokens = 0;
    if (message) {
      try {
        tokens = ctx.tokenMeter.estimateMessage(message);
      } catch {
        reportDegrade(session, logger, 'tokenMeter-unavailable');
      }
    }
    return total + tokens;
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
      attemptCount: summaryResult.rounds,
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
    // 压缩成功提交后写待定失效标记（提交失败则保留待定，边界后移使其自然过期）
    clearPending();
    logger.info(
      `观察压缩完成（替换 ${replaceSeqs.length} 个表层节点，约 ${shadowedTokenCount} tokens，压缩至${triggerNote}）`,
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
    // 提交失败为局部异常（压缩已成功）：记日志后继续本轮，不中断 turn；
    // 待定标记保留，边界后移后由 findObservePending 判定为过期（兜底崩溃窗口）
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
  const waitCount = config.tailMessageCount;
  logger.step('反思 pass 开始');
  const reflect = await reflectPass(ctx, agent, config, target, signal);
  if (reflect.failed) {
    logger.step('反思 pass 失败（本轮将被拒绝），跳过观察 pass');
    return reflect;
  }
  logger.step('反思 pass 结束，观察 pass 开始');
  const observe = await observePass(ctx, agent, config, waitCount, target, signal);
  logger.step('观察 pass 结束，压缩流程完成');
  return observe;
}
