/**
 * 自动压缩（OM 观察/反思两级阈值，思路参考 Mastra Observational Memory）：
 *  - 观察：未压缩消息 tokens ≥ 窗口 × thresholdRatio → 直连 ctx.llm.stream() 摘要
 *    （new 方式：指令作为 system、被压缩消息渲染为输入）把未压缩消息压缩为观察日志，
 *    作为独立的新 <om-history> 块，只精确替换被压缩的新消息区间（旧块原地保留，
 *    多块并存按序排列；不再把旧+新合并进一条消息）；
 *  - 反思：全部 <om-history> 块 tokens 合计 ≥ 窗口 × historyMergeRatio（默认 0.2）→
 *    同上摘要调用精简合并，把整个块区段合并为一条更紧凑的摘要。
 * 两级检查在 pre-step 阻塞串行执行（先反思后观察），避免压缩失败或重复压缩。
 * 自动压缩由配置键 omEnabled 开关（false 时关闭；recall 工具不受影响）。
 *
 * 压缩结果写入宿主 compaction/* 生命周期事件（compaction/start → compaction/summary →
 * 替换 <om-history> 消息 → compaction/end），使消息记录（聊天视图压缩卡片）与轨迹视图
 * 可见；compaction/summary 同时承担影子价格认领（shadowedTokenCount），不再单独发
 * compaction/prune。替换消息的 source 使用宿主 checkpoint 标记（plugin: 'compact' +
 * compactionId），UI 据此关联 summary 与替换消息。生命周期事件在摘要成功后才写入
 * （失败不产生任何日志变更）。
 *
 * 观察区间：pre-step 触发时日志 call-result 完备，区间不再受 turn/end 封顶——头部 →
 * 表层长度-1-tailCount（尾部保留 config.tailMessageCount 条不压缩），当前 turn 中已
 * 完备的消息同样可压缩；区间终点回退到 tool-call/result 配对平衡点（不切段）。
 * 观察摘要的条目用「完整消息」index 定位（三类定义见 log-index.ts）：新消息起始 index
 * 由插件从日志计算后注入提示词，输入按完整消息渲染绝对 index。
 * 仅主会话生效。
 */
import { COMPACT_CHECKPOINT_PLUGIN, HISTORY_TAG, PLUGIN_LABEL } from './constants.ts';
import { indexCompleteMessages } from './log-index.ts';
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
  /** 日志文本起点：优先块前换行定位（旧格式注入前缀句含行内 <om-history>，裸 indexOf 会抢先
   *  命中前缀里的标签），回退首个开标签；无则整段视为日志。 */
  const tag = `<${HISTORY_TAG}>`;
  const newlineStart = text.indexOf(`\n${tag}`);
  const start = newlineStart === -1 ? text.indexOf(tag) : newlineStart + 1;
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
 */
export function computeCompressRange(
  session: Session,
  tailCount: number,
): { start: number; end: number; shadowedSeqs: number[] } | undefined {
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
  return { start, end, shadowedSeqs };
}

/**
 * 收集表层中全部 <om-history> 压缩日志（内文 + seq，按表层顺序）。
 * 压缩日志消息始终位于表层头部连续区段（每次观察在旧块之后替换新消息区间，
 * 反思把整个块区段合并为一条），因此表层中所有压缩日志即头部区段；
 * 头部区段后即结束扫描（不遍历尾部消息）。
 */
export function listHistoryBlocks(session: Session): Array<{ text: string; seq: number }> {
  /** 收集结果（按表层顺序）。 */
  const out: Array<{ text: string; seq: number }> = [];
  for (const seq of session.surface.nodes) {
    /** <om-history> 内文（非压缩日志消息时为 undefined）。 */
    const text = historyTextOf(session.events[seq]);
    if (text === undefined) break;
    out.push({ text, seq });
  }
  return out;
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
  /** 压缩替换消息（内容即 <om-history> 标签块，不再附加前缀句；对 AI 的提醒在块开标签 tip 属性上；
   *  source 标记宿主 checkpoint 供 UI 关联）。 */
  const message = {
    id: uuid(),
    role: 'user',
    content: [{ type: 'text', text: content }],
    source: { kind: 'plugin', plugin: COMPACT_CHECKPOINT_PLUGIN, compactionId },
  } as unknown as UserMessage; // id 为品牌类型 MessageId，插件自产消息由 session.append 运行时校验
  session.append('user/message', message, { surfaceOp, sourceEventSeqs });
}

/**
 * 反思：全部 <om-history> 块 tokens 合计 ≥ 窗口 × historyMergeRatio 时，摘要调用
 * 精简合并，把整个块区段替换为一条更紧凑的摘要。失败不产生部分替换。
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
  const logger = makeLogger(ctx, config.debug);
  logger.step(`反思检查（窗口 ${window} × historyMergeRatio ${config.historyMergeRatio}）`);
  /** 全部 <om-history> 块（头部连续区段；无则跳过）。 */
  const blocks = listHistoryBlocks(session);
  if (blocks.length === 0) {
    logger.step('反思：无 <om-history> 压缩日志，跳过');
    return;
  }
  /** 反思阈值（窗口 × historyMergeRatio 向下取整）。 */
  const threshold = Math.floor(window * config.historyMergeRatio);
  /** 全部块 token 估算合计（摘要总长）。 */
  const tokens = blocks.reduce((total, block) => total + estimateTextTokens(block.text), 0);
  if (tokens < threshold) {
    logger.step(`反思：摘要 ${tokens} tokens < 阈值 ${threshold}，跳过`);
    return;
  }
  logger.step(
    `反思：摘要 ${tokens} tokens ≥ 阈值 ${threshold}，触发精简合并（${blocks.length} 个块）`,
  );
  /** 块区段首尾（listHistoryBlocks 只收集表层节点，天然在表层）。 */
  const first = blocks[0];
  const last = blocks[blocks.length - 1];
  if (first === undefined || last === undefined) {
    logger.step('反思：块区段缺失，跳过');
    return;
  }
  /** 被替换块区段的 seq 列表。 */
  const blockSeqs = blocks.map((block) => block.seq);
  /** 反思指令（persona + 规则主体）。 */
  const instruction = `${REFLECTOR_PERSONA}\n\n${buildReflectPrompt()}`;
  /** 渲染输入（全部 <om-history> 块内文）。 */
  const contextText = blocks.map((block) => block.text).join('\n');
  /** 反思摘要结果（null 表示失败/跳过）。 */
  const summaryResult = await runSummarySubagent(
    ctx,
    agent,
    instruction,
    contextText,
    config.compressMaxTokens,
    target,
    config.debug,
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
      shadowedRange: { start: first.seq, end: last.seq },
      shadowedSeqs: blockSeqs,
      shadowedTokenCount: tokens,
      provider: target.provider,
      model: target.model,
      maxTokens: config.compressMaxTokens,
      ...(summaryResult.usage === undefined ? {} : { usage: summaryResult.usage }),
    });
    logger.step('反思提交：替换整个 <om-history> 块区段为合并摘要');
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
  const logger = makeLogger(ctx, config.debug);
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
  /** 当前表层节点（按日志顺序）。 */
  const surface = [...session.surface.nodes];
  /** 头部 <om-history> 块区段（旧摘要；多块并存：保留不替换、不进新消息遮蔽）。 */
  const blocks = listHistoryBlocks(session);
  /** 区间终点在表层中的位置。 */
  const endIdx = surface.indexOf(range.end);
  /** 被替换的新消息区段起点（头部块区段之后）。 */
  const startIdx = blocks.length;
  /** 实际被替换的新消息表层节点（旧块不进入遮蔽、不被重写）。 */
  const replaceSeqs = surface.slice(startIdx, endIdx + 1);
  /** 替换区间起点（首个新消息节点；区间内全部为块时无新消息可压缩）。 */
  const replaceStart = replaceSeqs[0];
  if (replaceStart === undefined) {
    logger.step('观察：区间内无新消息（全部为压缩日志块），跳过');
    return;
  }
  /** 被替换 seq 集合（计算新消息起始 index）。 */
  const shadowedSet = new Set(replaceSeqs);
  /** 压缩区间内第一个完整消息的 index（新消息起始编号；区间内无完整消息则 0）。 */
  const startIndex =
    indexCompleteMessages(session).find((cm) => cm.seqs.every((seq) => shadowedSet.has(seq)))
      ?.index ?? 0;
  logger.step(
    `观察：保留旧块 ${blocks.length} 条，替换新消息 [${replaceSeqs[0]}..${range.end}]（${replaceSeqs.length} 条），尾部保留 ${tailCount} 条（不压缩、不进日志），新消息起始 index ${startIndex}`,
  );
  /** 观察指令（persona + 规则主体）。 */
  const prompt = buildObservePrompt({
    startIndex,
    hasOldHistory: blocks.length > 0,
  });
  const instruction = `${OBSERVER_PERSONA}\n\n${prompt}`;
  /** 渲染输入：本次要压缩的完整消息（含绝对 index；不含尾部，插件自产消息不占位）。 */
  const contextText = renderMessages(session, replaceSeqs);
  /** 观察摘要结果（null 表示失败/跳过）。 */
  const summaryResult = await runSummarySubagent(
    ctx,
    agent,
    instruction,
    contextText,
    config.compressMaxTokens,
    target,
    config.debug,
    signal,
  );
  if (summaryResult === null || summaryResult.text.trim().length === 0) {
    logger.step('观察：摘要调用失败/无输出，不产生替换');
    return;
  }
  /** 观察摘要文本（独立新块；旧块保留，不再合并）。 */
  const report = summaryResult.text;
  /** 被替换表层节点的 token 估算合计（仅新消息区间）。 */
  const shadowedTokenCount = replaceSeqs.reduce((total, seq) => {
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
      summary: report,
      shadowedRange: { start: replaceStart, end: range.end },
      shadowedSeqs: replaceSeqs,
      shadowedTokenCount,
      provider: target.provider,
      model: target.model,
      maxTokens: config.compressMaxTokens,
      ...(summaryResult.usage === undefined ? {} : { usage: summaryResult.usage }),
    });
    logger.step('观察提交：替换被压缩新消息区间为 <om-history>（旧块保留）');
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
      `观察压缩完成（未压缩 ${uncompressedTokens} tokens ≥ 阈值 ${threshold}，替换 ${replaceSeqs.length} 个表层节点，约 ${shadowedTokenCount} tokens）`,
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
  const logger = makeLogger(ctx, config.debug);
  /** omEnabled=false：关闭自动压缩（观察/反思均不触发，recall 工具不受影响）。 */
  if (!config.omEnabled) {
    logger.step('omEnabled=false，跳过压缩');
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
