/**
 * 自动压缩（OM 观察/反思两级阈值，思路参考 Mastra Observational Memory）：
 *  - 观察：未压缩消息 tokens ≥ 窗口 × thresholdRatio → 直连 ctx.llm.stream() 摘要
 *    （fork 模式复用主会话请求前缀缓存；new 模式指令作为 system）把未压缩消息压缩为
 *    观察日志，以新的 <om-history> 块追加到旧日志（多块按序拼接），替换被压缩消息区间；
 *  - 反思：摘要 tokens ≥ 窗口 × historyMergeRatio（默认 0.2）→ 同上摘要调用精简合并摘要，
 *    替换单个 <om-history> 节点。
 * 两级检查在 pre-step 阻塞串行执行（先反思后观察），避免压缩失败或重复压缩。
 *
 * 压缩结果写入宿主 compaction/* 生命周期事件（compaction/start → compaction/summary →
 * 替换 <om-history> 消息 → compaction/end），使消息记录（聊天视图压缩卡片）与轨迹视图
 * 可见；compaction/summary 同时承担影子价格认领（shadowedTokenCount），不再单独发
 * compaction/prune。替换消息的 source 使用宿主 checkpoint 标记（plugin: 'compact' +
 * compactionId），UI 据此关联 summary 与替换消息。生命周期事件在摘要成功后才写入
 * （失败不产生任何日志变更）。
 *
 * 观察区间：pre-step 触发时日志 call-result 完备，区间不再受 turn/end 封顶——头部 →
 * 表层长度-1-tailCount（尾部保留 config.tailMessageCount 条不压缩，作为摘要模型的
 * 参考尾部），当前 turn 中已完备的消息同样可压缩；区间终点回退到 tool-call/result
 * 配对平衡点（不切段）。
 * 仅主会话生效。
 */
import { COMPACT_CHECKPOINT_PLUGIN, HISTORY_TAG, PLUGIN_LABEL } from './constants.ts';
import { messageIdOfEvent, surfaceIndexOf } from './log-index.ts';
import { makeLogger } from './logger.ts';
import {
  buildObservePrompt,
  buildReflectPrompt,
  OBSERVER_PERSONA,
  REFLECTOR_PERSONA,
  renderMessages,
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

/**
 * 判定消息是否为本插件的压缩日志消息并提取日志文本（D：不通过文本含 <om-history> 判断，
 * 改用 source 标记——plugin 为宿主 checkpoint 标记 'compact' 或插件标识 'dsh-plugin-om'）。
 * 日志文本取首个 <om-history> 起的内容（含标签与格式说明注释，多块拼接时返回全部块）；
 * 非压缩日志消息返回 undefined。
 */
function historyTextOf(event: SessionEvent | undefined): string | undefined {
  if (event?.type !== 'user/message') return undefined;
  /** 消息 source（插件自产消息的标记）。 */
  const source = event.data.source as { kind?: string; plugin?: string } | undefined;
  if (source?.kind !== 'plugin') return undefined;
  if (source.plugin !== COMPACT_CHECKPOINT_PLUGIN && source.plugin !== PLUGIN_LABEL)
    return undefined;
  /** 消息纯文本。 */
  const text = blocksToText(event.data.content);
  /** 首个 <om-history> 的位置（日志文本起点；无则整段视为日志）。 */
  const start = text.indexOf(`<${HISTORY_TAG}>`);
  return start === -1 ? text : text.slice(start);
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
 * 判定表层节点 seq 之后的切点是否 tool-call/result 配对平衡（与宿主
 * dsh-compaction 的 toolPairingBalancedAfter 同语义）：按表层顺序折叠未闭合的
 * 工具调用数，处理到 seq 后计数为 0 即平衡。pre-step 时日志 call-result 完备，
 * 该检查作为区间边界的安全网（防止把助手 tool-call 与其结果切到两侧）。
 */
export function isPairBalancedAfter(session: Session, seq: number): boolean {
  /** 未闭合工具调用计数。 */
  let inProgress = 0;
  for (const node of session.surface.nodes) {
    /** 当前表层事件。 */
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
 * 观察压缩区间：pre-step 触发时日志 call-result 完备，区间不再受 turn/end 封顶——
 * 头部 → 表层长度-1-tailCount（尾部保留 tailCount 条不压缩），当前 turn 中已完备的
 * 消息同样可压缩；区间终点回退到 tool-call/result 配对平衡点（不切段）。
 * lastEndSeq 仅为中断扫描提供最后一个已结束 turn 的边界（无则 -1）。
 */
export function computeCompressRange(
  session: Session,
  tailCount: number,
): { start: number; end: number; shadowedSeqs: number[]; lastEndSeq: number } | undefined {
  /** 当前表层节点（按日志顺序）。 */
  const surface = [...session.surface.nodes];
  if (surface.length === 0) return undefined;
  /** 区间末表层节点下标（尾部保留 tailCount 条不压缩）。 */
  let endIdx = surface.length - 1 - tailCount;
  if (endIdx < 0) return undefined;
  /** 区间终点回退到配对平衡点（不切断 tool-call/result 配对）。 */
  while (endIdx >= 0) {
    /** 当前候选终点节点（表层节点序列稠密，防御性判空）。 */
    const node = surface[endIdx];
    if (node === undefined || isPairBalancedAfter(session, node)) break;
    endIdx -= 1;
  }
  if (endIdx < 0) return undefined;
  /** 区间起点（表层首节点，含旧 <om-history> 时一并合并）。 */
  const start = surface[0];
  /** 区间终点（表层节点 seq）。 */
  const end = surface[endIdx];
  if (start === undefined || end === undefined) return undefined;
  /** 被遮蔽的表层 seq 列表。 */
  const shadowedSeqs = surface.slice(0, endIdx + 1);
  /** 最后一个 turn/end（中断扫描边界；无则 -1）。 */
  const lastEnd = session.events.findLast((event) => event.type === 'turn/end');
  return { start, end, shadowedSeqs, lastEndSeq: lastEnd?.seq ?? -1 };
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
 * 如运行时上下文快照与 <om-history> 不入表；观察摘要据此产出正确的 message_id）。
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
        /** 关联调用 id（供摘要模型按 callId 定位代码与结果）。 */
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
 * summary 为完整合并后的 <om-history> 内文；usage 由摘要调用提取（无则省略）。
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
  /** 压缩替换消息（内容已含 <om-history> 标签块，不再额外包裹；source 标记宿主 checkpoint 供 UI 关联）。 */
  const message = {
    id: uuid(),
    role: 'user',
    content: [
      {
        type: 'text',
        text: [
          '以下是过往会话的压缩日志（<om-history>），为已确立背景：直接继续，不要复述。',
          '',
          content,
        ].join('\n'),
      },
    ],
    source: { kind: 'plugin', plugin: COMPACT_CHECKPOINT_PLUGIN, compactionId },
  } as unknown as UserMessage; // id 为品牌类型 MessageId，插件自产消息由 session.append 运行时校验
  session.append('user/message', message, { surfaceOp, sourceEventSeqs });
}

/**
 * 反思：摘要 tokens ≥ 窗口 × historyMergeRatio 时，摘要调用精简合并摘要，
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
  /** 插件日志门面。 */
  const logger = makeLogger(ctx);
  logger.step(`反思检查（窗口 ${window} × historyMergeRatio ${config.historyMergeRatio}）`);
  /** 当前摘要（最后一次 <om-history>；无则跳过）。 */
  const history = findLatestHistory(session);
  if (!history) {
    logger.step('反思：无 <om-history> 压缩日志，跳过');
    return;
  }
  /** 反思阈值（窗口 × historyMergeRatio 向下取整）。 */
  const threshold = Math.floor(window * config.historyMergeRatio);
  /** 摘要 token 估算。 */
  const tokens = estimateTextTokens(history.text);
  if (tokens < threshold) {
    logger.step(`反思：摘要 ${tokens} tokens < 阈值 ${threshold}，跳过`);
    return;
  }
  logger.step(`反思：摘要 ${tokens} tokens ≥ 阈值 ${threshold}，触发精简合并`);
  /** 摘要节点须仍在表层才可替换。 */
  if (surfaceIndexOf([...session.surface.nodes], history.seq) === -1) {
    logger.step('反思：摘要节点已不在表层，跳过');
    return;
  }
  /** 反思指令（persona + 规则主体）。 */
  const instruction = `${REFLECTOR_PERSONA}\n\n${buildReflectPrompt(config.summaryMode)}`;
  /** new 模式的渲染输入（当前 <om-history> 内文）。 */
  const contextText = config.summaryMode === 'new' ? history.text : undefined;
  /** 反思摘要结果（null 表示失败/跳过）。 */
  const summaryResult = await runSummarySubagent(
    ctx,
    agent,
    instruction,
    contextText,
    config.compressMaxTokens,
    config.summaryMode,
    0, // 反思注入完整历史（尾部不裁剪；只精简合并日志本身）
    target,
    signal,
  );
  if (summaryResult === null || summaryResult.text.trim().length === 0) {
    logger.step('反思：摘要调用失败/无输出，不产生替换');
    return;
  }
  /** 反思摘要文本。 */
  const report = summaryResult.text;
  /** 本次压缩生命周期（compactionId + 当前轮次；摘要成功后才写入日志）。 */
  const lifecycle: CompactionLifecycle = {
    compactionId: newCompactionId(),
    turn: openTurnOf(session),
  };
  try {
    logger.step('反思提交：追加 compaction/start');
    appendCompactionStart(session, lifecycle);
    logger.step('反思提交：追加 compaction/summary（影子价格认领）');
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
      ...(summaryResult.usage === undefined ? {} : { usage: summaryResult.usage }),
    });
    logger.step('反思提交：替换 <om-history> 摘要节点');
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
    logger.step('反思提交：追加 compaction/end');
    appendCompactionEnd(session, lifecycle);
    logger.info(`反思完成（摘要 ${tokens} tokens ≥ 阈值 ${threshold}，替换摘要节点）`);
  } catch (error) {
    /** 提交失败信息（统一字符串）。 */
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`反思提交失败: ${message}`);
    try {
      appendCompactionEnd(session, lifecycle, message);
    } catch {
      /* end 追加失败忽略（start 已记录，日志仍可诊断） */
    }
  }
}

/**
 * 观察：未压缩消息 tokens ≥ 窗口 × thresholdRatio 时，摘要调用把未压缩消息压缩为
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
  /** 插件日志门面。 */
  const logger = makeLogger(ctx);
  logger.step(
    `观察检查（窗口 ${window} × thresholdRatio ${config.thresholdRatio}，尾部保留 ${tailCount} 条）`,
  );
  /** 观察阈值（窗口 × thresholdRatio 向下取整）。 */
  const threshold = Math.floor(window * config.thresholdRatio);
  /** 未压缩消息 token 估算（不含 <om-history> 摘要节点）。 */
  const uncompressedTokens = measureUncompressedTokens(session, ctx.tokenMeter);
  if (uncompressedTokens < threshold) {
    logger.step(`观察：未压缩消息 ${uncompressedTokens} tokens < 阈值 ${threshold}，跳过`);
    return;
  }
  logger.step(`观察：未压缩消息 ${uncompressedTokens} tokens ≥ 阈值 ${threshold}，触发压缩`);
  /** 观察压缩区间（尾部保留 tailCount 条不压缩；无可行区间则跳过）。 */
  const range = computeCompressRange(session, tailCount);
  if (!range) {
    logger.step('观察：无可行压缩区间（表层过短或配对无法平衡），跳过');
    return;
  }
  logger.step(
    `观察：压缩区间 [${range.start}..${range.end}]，遮蔽 ${range.shadowedSeqs.length} 个表层节点`,
  );
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
  /** 实际保留的参考尾部条数（配对回退可能多于 tailCount；fork 输入从尾部之前实际截断）。 */
  const surface = [...session.surface.nodes];
  const actualTailCount = surface.length - range.shadowedSeqs.length;
  logger.step(
    `观察：实际保留尾部 ${actualTailCount} 条（不压缩、不进日志），中断标记 ${interruptions.length} 条，message_id 对照表 ${table.length} 行`,
  );
  /** 观察指令（persona + 规则主体）。 */
  const prompt = buildObservePrompt({
    table,
    interruptions,
    hasOldHistory: history !== undefined,
    mode: config.summaryMode,
  });
  const instruction = `${OBSERVER_PERSONA}\n\n${prompt}`;
  /** new 模式的渲染输入：本次要压缩的消息（过滤旧 <om-history> 日志消息；不含尾部）。 */
  const contextText =
    config.summaryMode === 'new'
      ? renderMessages(
          session,
          range.shadowedSeqs.filter((seq) => historyTextOf(session.events[seq]) === undefined),
        )
      : undefined;
  /** 观察摘要结果（null 表示失败/跳过）。 */
  const summaryResult = await runSummarySubagent(
    ctx,
    agent,
    instruction,
    contextText,
    config.compressMaxTokens,
    config.summaryMode,
    actualTailCount, // fork 输入从尾部之前实际截断（new 模式输入本身不含尾部）
    target,
    signal,
  );
  if (summaryResult === null || summaryResult.text.trim().length === 0) {
    logger.step('观察：摘要调用失败/无输出，不产生替换');
    return;
  }
  /** 观察摘要文本。 */
  const report = summaryResult.text;
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
  /** 本次压缩生命周期（compactionId + 当前轮次；摘要成功后才写入日志）。 */
  const lifecycle: CompactionLifecycle = {
    compactionId: newCompactionId(),
    turn: openTurnOf(session),
  };
  try {
    logger.step('观察提交：追加 compaction/start');
    appendCompactionStart(session, lifecycle);
    logger.step('观察提交：追加 compaction/summary（影子价格认领）');
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
      ...(summaryResult.usage === undefined ? {} : { usage: summaryResult.usage }),
    });
    logger.step('观察提交：替换被压缩消息区间为 <om-history>');
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
    logger.step('观察提交：追加 compaction/end');
    appendCompactionEnd(session, lifecycle);
    logger.info(
      `观察压缩完成（未压缩 ${uncompressedTokens} tokens ≥ 阈值 ${threshold}，遮蔽 ${range.shadowedSeqs.length} 个表层节点，约 ${shadowedTokenCount} tokens）`,
    );
  } catch (error) {
    /** 提交失败信息（统一字符串）。 */
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`观察压缩提交失败: ${message}`);
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
  /** 插件日志门面。 */
  const logger = makeLogger(ctx);
  /** disable 模式：关闭自动压缩（观察/反思均不触发，recall 工具不受影响）。 */
  if (config.summaryMode === 'disable') {
    logger.step('summaryMode=disable，跳过压缩');
    return;
  }
  /** 会话路由目标（未路由无法查询容量）。 */
  const target = routedTarget(session);
  if (target === undefined) {
    logger.step('会话未路由（无 provider/model），跳过压缩');
    return;
  }
  logger.step(`会话路由：provider ${target.provider}，model ${target.model}`);
  /** 模型容量信息（contextWindow 决定两级阈值）。 */
  let info: Awaited<ReturnType<typeof ctx.llm.resolveModelInfo>> | undefined;
  try {
    info = await ctx.llm.resolveModelInfo(target.provider, target.model, signal);
  } catch (error) {
    logger.warn(`解析模型容量失败: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  /** 模型上下文窗口大小（非法值视为无法压缩）。 */
  const window = info.context?.contextWindow;
  if (typeof window !== 'number' || !Number.isFinite(window) || window <= 0) {
    logger.step(`模型上下文窗口非法（${String(window)}），跳过压缩`);
    return;
  }
  logger.step(`模型上下文窗口 ${window} tokens，开始两级压缩（先反思后观察）`);
  /** 尾部保留条数（config.tailMessageCount，缺省 10）。 */
  const tailCount = config.tailMessageCount;
  // 先反思（压缩过往摘要），后观察（压缩新消息，有必要才做）
  logger.step('反思 pass 开始');
  await reflectPass(ctx, agent, config, window, target, signal);
  logger.step('反思 pass 结束，观察 pass 开始');
  await observePass(ctx, agent, config, window, tailCount, target, signal);
  logger.step('观察 pass 结束，压缩流程完成');
}
