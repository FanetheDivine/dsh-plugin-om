/**
 * 自动压缩（OM 观察/反思两级阈值，思路参考 Mastra Observational Memory）：
 *  - 观察：未压缩消息 tokens ≥ 窗口 × thresholdRatio → fork 子会话把未压缩消息压缩为
 *    观察日志，追加到旧摘要（<om-history> 原文保留），替换被压缩消息区间；
 *  - 反思：摘要 tokens ≥ 窗口 × historyMergeRatio（默认 0.2）→ fork 子会话精简合并摘要，
 *    替换单个 <om-history> 节点。
 * 两级检查在 pre-step 阻塞串行执行（先反思后观察），避免压缩失败或重复压缩。
 *
 * 压缩结果写入宿主 compaction/* 生命周期事件（compaction/start → compaction/summary →
 * 替换 <om-history> 消息 → compaction/end），使消息记录（聊天视图压缩卡片）与轨迹视图
 * 可见；compaction/summary 同时承担影子价格认领（shadowedTokenCount），不再单独发
 * compaction/prune。替换消息的 source 使用宿主 checkpoint 标记（plugin: 'compact' +
 * compactionId），UI 据此关联 summary 与替换消息。生命周期事件在 fork 摘要成功后才写入
 * （失败不产生任何日志变更）。
 *
 * 观察区间：尾部保留 config.tailMessageCount（默认 10）条消息不压缩；
 * 其余全部未压缩消息一次压缩。fork seed 截断于最后一个 turn/end，
 * 故区间表层节点封顶在最后一个已结束 turn 的表层节点（当前 turn 消息留待下次）。
 * 仅主会话生效。
 */
import { COMPACT_CHECKPOINT_PLUGIN, HISTORY_TAG } from './constants.ts';
import { messageIdOfEvent, surfaceIndexOf } from './log-index.ts';
import {
  buildObservePrompt,
  buildReflectPrompt,
  OBSERVER_PERSONA,
  REFLECTOR_PERSONA,
  runSummarySubagent,
} from './summarize.ts';
import type {
  Agent,
  CompactionId,
  Context,
  PluginConfig,
  Session,
  SessionEvent,
  TokenUsage,
  UserMessage,
} from './types.ts';
import { blocksToText, type RoutedTarget, routedTarget, uuid } from './utils.ts';

/** 历史文本 token 估算：4 字符 ≈ 1 token（与宿主 dsh-token-meter 启发式一致）。 */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** 提取 <om-history> 压缩日志消息的内文（去掉标签）；非压缩日志消息返回 undefined。 */
function historyTextOf(event: SessionEvent | undefined): string | undefined {
  if (event?.type !== 'user/message') return undefined;
  /** 消息纯文本。 */
  const text = blocksToText(event.data.content);
  return text.includes(`<${HISTORY_TAG}>`)
    ? text.replace(new RegExp(`</?${HISTORY_TAG}>`, 'g'), '').trim()
    : undefined;
}

/** token 估算器的结构类型（仅需 estimateMessage；避免依赖完整 TokenMeter 接口）。 */
export type TokenEstimator = { estimateMessage(message: unknown): number };

/**
 * 未压缩消息 token 估算：表层节点合计，不含 <om-history> 摘要节点
 * （观察阈值衡量对象）。
 */
export function measureUncompressedTokens(session: Session, meter: TokenEstimator): number {
  /** token 合计。 */
  let total = 0;
  for (const seq of session.surface.nodes) {
    /** 当前表层事件（摘要节点不计入未压缩消息）。 */
    const event = session.events[seq];
    if (historyTextOf(event) !== undefined) continue;
    /** 事件对应的消息（用于 token 估算）。 */
    const message = event ? session.deriveEventMessage(event) : null;
    total += message ? meter.estimateMessage(message) : 0;
  }
  return total;
}

/** 定位日志中最后一次 <om-history> 压缩日志（内文 + 事件 seq）；无则 undefined。 */
export function findLatestHistory(session: Session): { text: string; seq: number } | undefined {
  /** 会话事件（仅追加，从后向前扫描）。 */
  const events = session.events;
  for (let seq = events.length - 1; seq >= 0; seq -= 1) {
    /** <om-history> 内文（非压缩日志消息时为 undefined）。 */
    const text = historyTextOf(events[seq]);
    if (text !== undefined) return { text, seq };
  }
  return undefined;
}

/**
 * 观察压缩区间：尾部保留 tailCount 条消息不压缩，区间封顶在最后一个已结束 turn 的
 * 表层节点（fork seed 截断于最后一个 turn/end，当前 turn 消息不可压缩）。
 */
export function computeCompressRange(
  session: Session,
  tailCount: number,
): { start: number; end: number; shadowedSeqs: number[]; lastEndSeq: number } | undefined {
  /** 当前表层节点（按日志顺序）。 */
  const surface = [...session.surface.nodes];
  if (surface.length === 0) return undefined;
  /** 最后一个 turn/end（fork seed 截断于此；无则无可压缩内容）。 */
  const lastEnd = session.events.findLast((event) => event.type === 'turn/end');
  if (!lastEnd) return undefined;
  /** seed 覆盖的最后表层节点下标（其后为当前 turn 消息，不可压缩）。 */
  let seedIdx = -1;
  for (let i = surface.length - 1; i >= 0; i -= 1) {
    const node = surface[i];
    if (node !== undefined && node <= lastEnd.seq) {
      seedIdx = i;
      break;
    }
  }
  if (seedIdx === -1) return undefined;
  /** 区间末表层节点下标（尾部保留与 seed 封顶取小）。 */
  const endIdx = Math.min(surface.length - 1 - tailCount, seedIdx);
  if (endIdx < 0) return undefined;
  /** 区间起点（表层首节点）。 */
  const start = surface[0];
  /** 区间终点（表层节点 seq）。 */
  const end = surface[endIdx];
  if (start === undefined || end === undefined) return undefined;
  /** 被遮蔽的表层 seq 列表。 */
  const shadowedSeqs = surface.slice(0, endIdx + 1);
  return { start, end, shadowedSeqs, lastEndSeq: lastEnd.seq };
}

/**
 * 中断标记行：范围内 turn/end 以 aborted（含 cause 类型）或 interrupted 结束的轮次
 * （标记用途：让摘要 AI 理解中断原因）。
 */
export function scanInterruptions(session: Session, fromSeq: number, toSeq: number): string[] {
  /** 标记行缓冲区。 */
  const marks: string[] = [];
  for (let seq = fromSeq + 1; seq <= toSeq; seq += 1) {
    /** 当前待检查事件。 */
    const event = session.events[seq];
    if (event?.type !== 'turn/end') continue;
    /** 结束原因（判别 kind）。 */
    const reason = event.data.reason;
    if (!reason || typeof reason !== 'object') continue;
    if (reason.kind === 'aborted') {
      /** 取消来源（user/parent/hook/disposed；未知标记 unknown）。 */
      const cause = (reason as { reason?: { kind?: string } }).reason?.kind ?? 'unknown';
      marks.push(`[interrupted] turn ${String(event.data.turn)} 被中断（aborted，原因 ${cause}）`);
    } else if (reason.kind === 'interrupted') {
      marks.push(`[interrupted] turn ${String(event.data.turn)} 因崩溃恢复中断（interrupted）`);
    }
  }
  return marks;
}

/**
 * 提取遮蔽区间内最后一次 <om-history> 压缩日志（内文 + seq）。
 * 按表层顺序（shadowedSeqs）扫描：单节点替换（反思）后摘要节点 seq 可能大于
 * 被压缩消息的 seq，按 seq 区间扫描会漏（start > end）。
 */
export function extractHistoryText(
  session: Session,
  shadowedSeqs: readonly number[],
): { text: string; seq: number } | undefined {
  /** 区间内找到的最近一次压缩日志。 */
  let found: { text: string; seq: number } | undefined;
  for (const seq of shadowedSeqs) {
    /** <om-history> 内文。 */
    const text = historyTextOf(session.events[seq]);
    if (text !== undefined) found = { text, seq };
  }
  return found;
}

/**
 * message_id 对照表：遮蔽区间内消息事件按表层顺序产出 id 行（插件自产 user/message
 * 如运行时上下文快照与 <om-history> 不入表；观察子会话据此产出正确的 message_id）。
 * 按表层顺序（shadowedSeqs）扫描：与 extractHistoryText 同理，seq 区间扫描会漏。
 */
export function buildMessageIdTable(session: Session, shadowedSeqs: readonly number[]): string[] {
  /** 对照表行缓冲区。 */
  const rows: string[] = [];
  for (const seq of shadowedSeqs) {
    /** 当前待检查事件。 */
    const event = session.events[seq];
    if (!event) continue;
    if (event.type === 'user/message') {
      /** 事件 source（插件自产消息不入表）。 */
      const source = event.data.source as { kind?: string } | undefined;
      if (source?.kind === 'plugin') continue;
      /** 用户消息 id。 */
      const id = messageIdOfEvent(event);
      if (id) rows.push(`[user] message_id=${id}`);
    } else if (event.type === 'assistant/message') {
      /** 助手消息 id。 */
      const id = messageIdOfEvent(event);
      if (id) rows.push(`[assistant] message_id=${id}`);
    } else if (event.type === 'tool/result') {
      /** 结果消息 id。 */
      const id = messageIdOfEvent(event);
      if (id) {
        /** 关联调用 id（供子会话按 callId 定位代码与结果）。 */
        const callId = String(event.data.message.source.callId ?? '');
        rows.push(`[tool/result callId=${callId}] message_id=${id}`);
      }
    }
  }
  return rows;
}

/** 当前打开中的 turn 号（最近 turn/start 且未被 turn/end 关闭）；无则 null（跨轮次场景）。 */
function openTurnOf(session: Session): number | null {
  /** 折叠结果（turn/start 打开、turn/end 关闭）。 */
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

/** compaction 生命周期共享数据（start/summary/end 以 compactionId 关联，turn 标记所属轮次）。 */
type CompactionLifecycle = {
  compactionId: CompactionId;
  turn: number | null;
};

/** 追加 compaction/start（log-only：仅标记生命周期开始，不进入表层），返回事件 seq。 */
function appendCompactionStart(session: Session, lifecycle: CompactionLifecycle): number {
  return session.append('compaction/start', lifecycle).seq;
}

/**
 * 追加 compaction/summary（log-only，承担影子价格认领：紧随其后的替换消息消费 claim）。
 * summary 为完整合并后的 <om-history> 内文；usage 由 fork 子会话提取（无则省略）。
 */
function appendCompactionSummary(
  session: Session,
  data: {
    lifecycle: CompactionLifecycle;
    summary: string;
    shadowedRange: { start: number; end: number };
    shadowedSeqs: number[];
    shadowedTokenCount: number;
    provider: string;
    model: string;
    maxTokens: number;
    usage?: TokenUsage;
  },
): number {
  return session.append('compaction/summary', {
    compactionId: data.lifecycle.compactionId,
    summary: [{ type: 'text', text: data.summary }],
    shadowedRange: data.shadowedRange,
    shadowedSeqs: data.shadowedSeqs,
    shadowedTokenCount: data.shadowedTokenCount,
    provider: data.provider,
    model: data.model,
    maxTokens: data.maxTokens,
    ...(data.usage === undefined ? {} : { usage: data.usage }),
  }).seq;
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

/** 追加 <om-history> 压缩日志消息（surfaceOp 替换遮蔽区间，source 为宿主 checkpoint 标记）。 */
function appendHistoryMessage(
  session: Session,
  content: string,
  sourceEventSeqs: number[],
  surfaceOp: { op: 'replace'; start: number; end: number },
  compactionId: CompactionId,
): void {
  /** 压缩替换消息（<om-history> 包裹摘要，source 标记宿主 checkpoint 供 UI 关联）。 */
  const message = {
    id: uuid(),
    role: 'user',
    content: [
      {
        type: 'text',
        text: [
          '以下是过往会话的压缩日志（<om-history>），为已确立背景：直接继续，不要复述。',
          '',
          `<${HISTORY_TAG}>`,
          content,
          `</${HISTORY_TAG}>`,
        ].join('\n'),
      },
    ],
    source: { kind: 'plugin', plugin: COMPACT_CHECKPOINT_PLUGIN, compactionId },
  } as unknown as UserMessage; // id 为品牌类型 MessageId，插件自产消息由 session.append 运行时校验
  session.append('user/message', message, { surfaceOp, sourceEventSeqs });
}

/**
 * 反思：摘要 tokens ≥ 窗口 × historyMergeRatio 时，fork 子会话精简合并摘要，
 * 替换单个 <om-history> 节点。失败不产生部分替换。
 */
export async function reflectPass(
  ctx: Context,
  agent: Agent,
  config: Readonly<PluginConfig>,
  window: number,
  target: RoutedTarget,
  signal?: AbortSignal,
): Promise<void> {
  /** 当前会话。 */
  const session = agent.session;
  /** 当前摘要（最后一次 <om-history>；无则跳过）。 */
  const history = findLatestHistory(session);
  if (!history) return;
  /** 反思阈值（窗口 × historyMergeRatio 向下取整）。 */
  const threshold = Math.floor(window * config.historyMergeRatio);
  /** 摘要 token 估算。 */
  const tokens = estimateTextTokens(history.text);
  if (tokens < threshold) return;
  /** 摘要节点须仍在表层才可替换。 */
  if (surfaceIndexOf([...session.surface.nodes], history.seq) === -1) return;
  /** 反思子会话输出（null 表示失败/跳过）。 */
  const report = await runSummarySubagent(
    ctx,
    agent,
    REFLECTOR_PERSONA,
    buildReflectPrompt(),
    config.compressMaxTokens,
    signal,
  );
  if (report === null || report.trim().length === 0) return;
  /** 本次压缩生命周期（compactionId + 当前轮次；fork 成功后才写入日志）。 */
  const lifecycle: CompactionLifecycle = {
    compactionId: newCompactionId(),
    turn: openTurnOf(session),
  };
  try {
    appendCompactionStart(session, lifecycle);
    /** compaction/summary 事件 seq（承担影子价格认领，紧随其后的替换消息消费）。 */
    const summarySeq = appendCompactionSummary(session, {
      lifecycle,
      summary: report,
      shadowedRange: { start: history.seq, end: history.seq },
      shadowedSeqs: [history.seq],
      shadowedTokenCount: tokens,
      provider: target.provider,
      model: target.model,
      maxTokens: config.compressMaxTokens,
    });
    appendHistoryMessage(
      session,
      report,
      [summarySeq, history.seq],
      {
        op: 'replace',
        start: history.seq,
        end: history.seq,
      },
      lifecycle.compactionId,
    );
    appendCompactionEnd(session, lifecycle);
    ctx.logger.info(
      `dsh-plugin-om: 反思完成（摘要 ${tokens} tokens ≥ 阈值 ${threshold}，替换摘要节点）`,
    );
  } catch (error) {
    /** 提交失败信息（统一字符串）。 */
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.warn(`dsh-plugin-om: 反思提交失败: ${message}`);
    try {
      appendCompactionEnd(session, lifecycle, message);
    } catch {
      /* end 追加失败忽略（start 已记录，日志仍可诊断） */
    }
  }
}

/**
 * 观察：未压缩消息 tokens ≥ 窗口 × thresholdRatio 时，fork 子会话把未压缩消息压缩为
 * 观察日志，追加到旧摘要并替换被压缩消息区间。失败不产生部分替换。
 */
export async function observePass(
  ctx: Context,
  agent: Agent,
  config: Readonly<PluginConfig>,
  window: number,
  tailCount: number,
  target: RoutedTarget,
  signal?: AbortSignal,
): Promise<void> {
  /** 当前会话。 */
  const session = agent.session;
  /** 观察阈值（窗口 × thresholdRatio 向下取整）。 */
  const threshold = Math.floor(window * config.thresholdRatio);
  /** 未压缩消息 token 估算（不含 <om-history> 摘要节点）。 */
  const uncompressedTokens = measureUncompressedTokens(session, ctx.tokenMeter);
  if (uncompressedTokens < threshold) return;
  /** 观察压缩区间（尾部保留 tailCount 条 + seed 封顶；无可行区间则跳过）。 */
  const range = computeCompressRange(session, tailCount);
  if (!range) return;
  /** 区间内旧摘要（追加基准；无则首次压缩）。 */
  const history = extractHistoryText(session, range.shadowedSeqs);
  // turn/end 事件在所属 turn 最后一个消息之后（seq 可大于 end），中断扫描取
  // 压缩消息的最小 seq 为起点、最后一个 turn/end 的 seq 为终点，覆盖被压缩轮次
  /** 中断标记行。 */
  const interruptions = scanInterruptions(
    session,
    Math.min(...range.shadowedSeqs),
    range.lastEndSeq,
  );
  /** message_id 对照表行。 */
  const table = buildMessageIdTable(session, range.shadowedSeqs);
  /** 观察提示词。 */
  const prompt = buildObservePrompt({
    table,
    interruptions,
    hasOldHistory: history !== undefined,
  });
  /** 观察子会话输出（null 表示失败/跳过）。 */
  const report = await runSummarySubagent(
    ctx,
    agent,
    OBSERVER_PERSONA,
    prompt,
    config.compressMaxTokens,
    signal,
  );
  if (report === null || report.trim().length === 0) return;
  /** 合并后的摘要（旧摘要原文保留，新观察日志追加在末尾）。 */
  const combined = [history?.text, report].filter(Boolean).join('\n');
  /** 被遮蔽表层节点的 token 估算合计。 */
  const shadowedTokenCount = range.shadowedSeqs.reduce((total, seq) => {
    /** 当前表层事件。 */
    const event = session.events[seq];
    /** 事件对应的消息（用于 token 估算）。 */
    const message = event ? session.deriveEventMessage(event) : null;
    return total + (message ? ctx.tokenMeter.estimateMessage(message) : 0);
  }, 0);
  /** 本次压缩生命周期（compactionId + 当前轮次；fork 成功后才写入日志）。 */
  const lifecycle: CompactionLifecycle = {
    compactionId: newCompactionId(),
    turn: openTurnOf(session),
  };
  try {
    appendCompactionStart(session, lifecycle);
    /** compaction/summary 事件 seq（承担影子价格认领，紧随其后的替换消息消费）。 */
    const summarySeq = appendCompactionSummary(session, {
      lifecycle,
      summary: combined,
      shadowedRange: { start: range.start, end: range.end },
      shadowedSeqs: range.shadowedSeqs,
      shadowedTokenCount,
      provider: target.provider,
      model: target.model,
      maxTokens: config.compressMaxTokens,
    });
    appendHistoryMessage(
      session,
      combined,
      [summarySeq, ...range.shadowedSeqs],
      {
        op: 'replace',
        start: range.start,
        end: range.end,
      },
      lifecycle.compactionId,
    );
    appendCompactionEnd(session, lifecycle);
    ctx.logger.info(
      `dsh-plugin-om: 观察压缩完成（未压缩 ${uncompressedTokens} tokens ≥ 阈值 ${threshold}，遮蔽 ${range.shadowedSeqs.length} 个表层节点，约 ${shadowedTokenCount} tokens）`,
    );
  } catch (error) {
    /** 提交失败信息（统一字符串）。 */
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.warn(`dsh-plugin-om: 观察压缩提交失败: ${message}`);
    try {
      appendCompactionEnd(session, lifecycle, message);
    } catch {
      /* end 追加失败忽略（start 已记录，日志仍可诊断） */
    }
  }
}

/**
 * 压力检查 + 两级压缩：先反思（压缩过往摘要，有必要才做），后观察（压缩新消息，
 * 有必要才做）。在 pre-step 阻塞串行执行（避免压缩失败或重复压缩）。仅主会话生效。
 */
export async function maybeCompress(
  ctx: Context,
  agent: Agent,
  config: Readonly<PluginConfig>,
  signal?: AbortSignal,
): Promise<void> {
  /** 当前会话。 */
  const session = agent.session;
  /** 会话路由目标（未路由无法查询容量）。 */
  const target = routedTarget(session);
  if (target === undefined) return;
  /** 模型容量信息（contextWindow 决定两级阈值）。 */
  let info: Awaited<ReturnType<typeof ctx.llm.resolveModelInfo>> | undefined;
  try {
    info = await ctx.llm.resolveModelInfo(target.provider, target.model, signal);
  } catch (error) {
    ctx.logger.warn(
      'dsh-plugin-om: 解析模型容量失败: ' +
        (error instanceof Error ? error.message : String(error)),
    );
    return;
  }
  /** 模型上下文窗口大小（非法值视为无法压缩）。 */
  const window = info.context?.contextWindow;
  if (typeof window !== 'number' || !Number.isFinite(window) || window <= 0) return;
  /** 尾部保留条数（config.tailMessageCount，缺省 10）。 */
  const tailCount = config.tailMessageCount;
  // 先反思（压缩过往摘要），后观察（压缩新消息，有必要才做）
  await reflectPass(ctx, agent, config, window, target, signal);
  await observePass(ctx, agent, config, window, tailCount, target, signal);
}
