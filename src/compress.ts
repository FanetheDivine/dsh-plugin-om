/**
 * 自动压缩（OM 观察/反思两级阈值，思路参考 Mastra Observational Memory）：
 *  - 观察：净压力 tokens（上下文压力 − 已压缩 <history> 块 tokens 合计）≥
 *    observeThresholdTokens（默认 30000）→ 直连 ctx.llm.stream()
 *    摘要（new 方式：共享提示词作为 system、被压缩消息渲染为 <history> 块输入）把未压缩消息
 *    压缩为观察日志，作为独立的新 <history> 块，只精确替换被压缩的新消息区间（旧块原地
 *    保留，多块并存按序排列；不再把旧+新合并进一条消息）。压力取自宿主 token-meter
 *    measure(session).totalTokens：provider 真实 usage 优先（最近一次成功调用的上报值锚定 +
 *    表层增量），不可信时自动回退启发式，与宿主上下文压力同口径；已压缩块 token 按
 *    块文本 4 字符 ≈ 1 token 估算（与反思同口径）；
 *  - 反思：全部 <history> 块 tokens 合计 ≥ reflectThresholdTokens（默认 40000）→
 *    同上摘要调用精简合并（输入为多个块拼接，共用同一套提示词），把整个块区段合并为一条。
 * 两级检查在 pre-step 阻塞串行执行（先反思后观察），避免压缩失败或重复压缩。
 * 自动压缩由配置键 omEnabled 开关（false 时关闭；recall 工具不受影响）。
 *
 * 压缩边界（historySection）：消息列表中最后一个合法的 <history> 块（source 为插件）
 * 之后的消息视为未压缩；其前（含自身）视为已压缩，不重复压缩。
 *
 * 压缩结果写入宿主 compaction/* 生命周期事件（compaction/start → compaction/summary →
 * 替换 <history> 消息 → compaction/end），使消息记录（聊天视图压缩卡片）与轨迹视图
 * 可见；compaction/summary 同时承担影子价格认领（shadowedTokenCount），不再单独发
 * compaction/prune。替换消息的 source 使用插件标识（plugin: 'dsh-plugin-om' +
 * compactionId），UI 据此关联 summary 与替换消息。compaction/start 在摘要调用前追加
 * （UI 压缩中提示行的开启标记，载荷带 phase 区分观察/反思）；摘要失败/无输出或提交
 * 失败时追加 compaction/end(error) 结束生命周期（失败不产生替换消息）。
 *
 * 观察区间：pre-step 触发时日志 call-result 完备，区间不再受 turn/end 封顶——压缩边界 →
 * 表层长度-1-tailCount（尾部保留 config.tailMessageCount 条不压缩），当前 turn 中已
 * 完备的消息同样可压缩；区间终点回退到 tool-call/result 配对平衡点（不切段）。
 * 摘要输出的 <history> 块经连续性校验（无 reasoning、index/start/end 连续且覆盖预期
 * 区间），失败按 config.compressRetryCount 重试。仅主会话生效。
 */
import { HISTORY_TAG, isPluginOwnedSource, PLUGIN_LABEL } from './constants.ts';
import { indexCompleteMessages } from './log-index.ts';
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

/** 历史文本 token 估算：4 字符 ≈ 1 token（与宿主 dsh-token-meter 启发式一致）。 */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * 有界并发池：最多 limit 个任务同时运行（limit 非法时按 1 处理），任务按 index 顺序
 * 取用，结果数组与 items 按 index 对齐（任务自身以返回值表达失败，不在此抛出）。
 * items 为空返回空数组。
 */
/**
 * 反思输入块引用的最大完整消息 index（解析全部条目取最大 end；无条目返回 -1）。
 * 反思输出必须覆盖输入引用的完整 index 区间（0..max），连续性校验据此约束。
 */
function reflectExpectedEnd(contextText: string): number {
  /** 最大 end（无条目保持 -1）。 */
  let max = -1;
  for (const e of parseHistoryEntries(contextText)) {
    /** 当前条目上界（模块 end 或单条 index）。 */
    const hi = e.kind === 'assistant' && e.end !== undefined ? e.end : (e.index ?? 0);
    if (hi > max) max = hi;
  }
  return max;
}

/**
 * 判定消息是否为本插件的压缩日志消息并提取日志文本（不通过文本含标签判断，
 * 改用 source 标记——plugin 为插件标识 'dsh-plugin-om'（兼容旧日志的宿主 checkpoint
 * 标记 'compact'）。
 * 仅当消息文本含 <history> 开标签（含带 tip 属性版本）时视为压缩日志，返回整段文本；
 * 其余消息返回 undefined（旧格式 <om-history> 块按「不兼容，干净切换」视为普通消息）。
 */
function historyTextOf(event: SessionEvent | undefined): string | undefined {
  if (event?.type !== 'user/message') return undefined;
  /** 消息 source（本插件自产消息的标记；含兼容旧宿主 checkpoint 标记）。 */
  const source = event.data.source as { kind?: string; plugin?: string } | undefined;
  if (!isPluginOwnedSource(source)) return undefined;
  /** 消息纯文本。 */
  const text = blocksToText(event.data.content);
  /** 首个 <history 出现位置（无则非压缩日志）。 */
  const idx = text.indexOf(`<${HISTORY_TAG}`);
  if (idx === -1) return undefined;
  /** 开标签校验：<history> 或 <history tip=…>（排除 </history> 等）。 */
  const rest = text.slice(idx + HISTORY_TAG.length + 1);
  if (!rest.startsWith('>') && !rest.startsWith(' tip=')) return undefined;
  return text;
}
/** 提取 <history> 块内文（去掉开/闭标签与首尾空白；非块文本原样返回）。 */
function historyInnerText(text: string): string {
  /** 闭标签。 */
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
  /** 压缩边界（最后一个 <history> 块；其前含自身已压缩，起点在其后）。 */
  const { boundarySeq } = historySection(session);
  /** 区间起点表层下标：无压缩日志时为 0；否则为压缩边界（最后一个 history 块）在表层
   *  （消息日志顺序）中的后继第一条消息。注意不能按 seq 比较取「边界之后」——替换块是
   *  追加到日志末尾的，其 seq 大于被遮蔽的消息；表层顺序才是消息的逻辑日志顺序。 */
  const startIdx = boundarySeq === undefined ? 0 : surface.indexOf(boundarySeq) + 1;
  if (startIdx >= surface.length) return undefined;
  /** 区间末表层节点下标（尾部保留 tailCount 条不压缩）。 */
  let endIdx = surface.length - 1 - tailCount;
  if (endIdx < startIdx) return undefined;
  /** 区间终点回退到配对平衡点（不切断 tool-call/result 配对）。 */
  while (endIdx >= startIdx) {
    /** 当前候选终点节点（表层节点序列稠密，防御性判空）。 */
    const node = surface[endIdx];
    if (node === undefined || isPairBalancedAfter(session, node)) break;
    endIdx -= 1;
  }
  if (endIdx < startIdx) return undefined;
  /** 区间起点（压缩边界后的首个节点）。 */
  const start = surface[startIdx];
  /** 区间终点（表层节点 seq）。 */
  const end = surface[endIdx];
  if (start === undefined || end === undefined) return undefined;
  /** 被遮蔽的表层 seq 列表（仅未压缩新消息，不含旧压缩日志块）。 */
  const shadowedSeqs = surface.slice(startIdx, endIdx + 1);
  return { start, end, shadowedSeqs };
}

/**
 * 压缩边界（historySection）：扫描表层全部节点，收集所有合法 <history> 压缩日志块
 * （内文 + seq，按表层顺序），并以最后一个块的 seq 作为压缩边界——
 * 边界之后的消息视为未压缩；其前（含边界自身）视为已压缩（不重复压缩、不计入观察阈值）。
 * 无压缩日志时 blocks 为空、boundarySeq 为 undefined（全部视为未压缩）。
 */
export function historySection(session: Session): {
  blocks: Array<{ text: string; seq: number }>;
  boundarySeq: number | undefined;
} {
  /** 收集结果（按表层顺序）。 */
  const blocks: Array<{ text: string; seq: number }> = [];
  /** 最后一个压缩日志块的 seq（无则 undefined）。 */
  let boundarySeq: number | undefined;
  for (const seq of session.surface.nodes) {
    /** <history> 内文（非压缩日志消息时为 undefined）。 */
    const text = historyTextOf(session.events[seq]);
    if (text === undefined) continue;
    blocks.push({ text, seq });
    boundarySeq = seq;
  }
  return { blocks, boundarySeq };
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
function appendCompactionStart(
  session: Session,
  lifecycle: CompactionLifecycle,
  phase: 'observe' | 'reflect',
): number {
  /** start 事件载荷（宿主类型 + 插件扩展 phase；宿主 append 不做 schema 剥离，扩展字段原样持久化）。 */
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
    /** 被压缩内容的字符数（压缩前文本长度合计；UI 标题统计用）。 */
    shadowedCharCount: number;
    provider: string;
    model: string;
    maxTokens: number;
    /** 摘要重试次数（0 起；观察分块为各块重试之和，反思为尝试次数 - 1）。 */
    attemptCount: number;
    usage?: TokenUsage;
  },
): number {
  /** summary 事件载荷（宿主类型 + 插件扩展 shadowedCharCount/attemptCount；宿主 append 不做 schema 剥离，扩展字段原样持久化）。 */
  const payload: CompactionSummaryPayload = {
    compactionId: data.lifecycle.compactionId,
    summary: [{ type: 'text', text: data.summary }],
    shadowedRange: data.shadowedRange,
    shadowedSeqs: data.shadowedSeqs,
    shadowedTokenCount: data.shadowedTokenCount,
    shadowedCharCount: data.shadowedCharCount,
    provider: data.provider,
    model: data.model,
    maxTokens: data.maxTokens,
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

/** 追加 <history> 压缩日志消息（surfaceOp 替换遮蔽区间，source 标记插件自产 + compactionId 关联压缩生命周期）。 */
function appendHistoryMessage(
  session: Session,
  content: string,
  sourceEventSeqs: number[],
  surfaceOp: { op: 'replace'; start: number; end: number },
  compactionId: CompactionId,
): void {
  /** 压缩替换消息（内容即 <history> 标签块，不再附加前缀句；对 AI 的提醒在块开标签 tip 属性上；
   *  source 标记插件标识（plugin: 'dsh-plugin-om'）+ compactionId 供 UI 关联）。 */
  const message = {
    id: uuid(),
    role: 'user',
    content: [{ type: 'text', text: content }],
    source: { kind: 'plugin', plugin: PLUGIN_LABEL, compactionId },
  } as unknown as UserMessage; // id 为品牌类型 MessageId，插件自产消息由 session.append 运行时校验
  session.append('user/message', message, { surfaceOp, sourceEventSeqs });
}

/**
 * 反思：全部 <history> 块 tokens 合计 ≥ reflectThresholdTokens 时，摘要调用
 * 精简合并（多个块拼接为输入，与观察共用同一套提示词），把整个块区段替换为一条
 * 更紧凑的摘要。失败不产生部分替换。
 */
export async function reflectPass(
  ctx: Context,
  agent: Agent,
  config: Readonly<PluginConfig>,
  target: RoutedTarget,
  signal?: AbortSignal,
): Promise<void> {
  /** 当前会话。 */
  const session = agent.session;
  /** 插件日志门面。 */
  const logger = makeLogger(ctx, config.debug);
  logger.step(`反思检查（反思阈值 ${config.reflectThresholdTokens} tokens）`);
  /** 全部 <history> 压缩日志块（按表层顺序；无则跳过）。 */
  const { blocks } = historySection(session);
  if (blocks.length === 0) {
    logger.step('反思：无 <history> 压缩日志，跳过');
    return;
  }
  /** 反思阈值（配置的绝对 token 数）。 */
  const threshold = config.reflectThresholdTokens;
  /** 全部块 token 估算合计（摘要总长）。 */
  const tokens = blocks.reduce((total, block) => total + estimateTextTokens(block.text), 0);
  /** 被压缩块区段的字符数合计（压缩前内文长度；UI 标题统计用，与观察路径一致只计内容不计标签）。 */
  const shadowedCharCount = blocks.reduce(
    (total, block) => total + historyInnerText(block.text).length,
    0,
  );
  if (tokens < threshold) {
    logger.step(`反思：摘要 ${tokens} tokens < 阈值 ${threshold}，跳过`);
    return;
  }
  logger.step(
    `反思：摘要 ${tokens} tokens ≥ 阈值 ${threshold}，触发精简合并（${blocks.length} 个块）`,
  );
  /** 块区段首尾（historySection 只收集表层节点，天然在表层）。 */
  const first = blocks[0];
  const last = blocks[blocks.length - 1];
  if (first === undefined || last === undefined) {
    logger.step('反思：块区段缺失，跳过');
    return;
  }
  /** 被替换块区段的 seq 列表。 */
  const blockSeqs = blocks.map((block) => block.seq);
  /** 共享提示词（观察/反思同一套）。 */
  const instruction = buildHistoryPrompt();
  /** 渲染输入（全部 <history> 块拼接）。 */
  const contextText = blocks.map((block) => block.text).join('\n');
  /** 反思输出应覆盖输入块引用的全部 index（解析输入条目取最大 end；无条目则只校验起点）。 */
  const expectedEnd = reflectExpectedEnd(contextText);
  /** 本次压缩生命周期（compactionId + 当前轮次；start 在摘要调用前开启，UI 压缩中提示）。 */
  const lifecycle: CompactionLifecycle = {
    compactionId: newCompactionId(),
    turn: openTurnOf(session),
  };
  try {
    logger.step('反思：追加 compaction/start（摘要调用前开启压缩中提示）');
    appendCompactionStart(session, lifecycle, 'reflect');
  } catch (error) {
    /** 启动失败信息（统一字符串）。 */
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`反思压缩启动失败: ${message}`);
    return;
  }
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
    {
      maxAttempts: config.compressRetryCount + 1,
      expected: expectedEnd < 0 ? { start: 0 } : { start: 0, end: expectedEnd },
      rateLimitWaitMs: config.rateLimitWaitMs,
    },
  );
  if (summaryResult === null || summaryResult.text.trim().length === 0) {
    logger.step('反思：摘要调用失败/无输出，追加 compaction/end(error)');
    try {
      appendCompactionEnd(session, lifecycle, '摘要调用失败/无输出');
    } catch {
      /* end 追加失败忽略（start 已记录，日志仍可诊断） */
    }
    return;
  }
  /** 反思摘要文本。 */
  const report = summaryResult.text;
  try {
    logger.step('反思提交：追加 compaction/summary（影子价格认领）');
    /** compaction/summary 事件 seq（承担影子价格认领，紧随其后的替换消息消费）。 */
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
 * 观察：净压力 tokens（上下文压力 − 已压缩 <history> 块 tokens 合计）≥
 * observeThresholdTokens 时（上下文压力取宿主 token-meter
 * measure(session).totalTokens：provider 真实 usage 优先、不可信回退启发式），摘要调用
 * 把未压缩消息压缩为观察日志，追加到旧摘要并替换被压缩消息区间。失败不产生部分替换。
 */
export async function observePass(
  ctx: Context,
  agent: Agent,
  config: Readonly<PluginConfig>,
  tailCount: number,
  target: RoutedTarget,
  signal?: AbortSignal,
): Promise<void> {
  /** 当前会话。 */
  const session = agent.session;
  /** 插件日志门面。 */
  const logger = makeLogger(ctx, config.debug);
  logger.step(
    `观察检查（观察阈值 ${config.observeThresholdTokens} tokens，尾部保留 ${tailCount} 条）`,
  );
  /** 观察阈值（配置的绝对 token 数）。 */
  const threshold = config.observeThresholdTokens;
  /** 上下文压力 token（宿主 token-meter：provider 真实 usage 优先，不可信回退启发式）。 */
  const pressureTokens = ctx.tokenMeter.measure(session).totalTokens;
  /** 旧压缩日志块（其 token 不计入观察触发压力——观察只压缩新消息；保留不替换、不进新消息遮蔽）。 */
  const { blocks } = historySection(session);
  /** 已压缩 <history> 块 token 估算合计（块文本 4 字符 ≈ 1 token，与反思同口径）。 */
  const historyTokens = blocks.reduce((total, block) => total + estimateTextTokens(block.text), 0);
  /** 净压力：上下文压力扣除已压缩块 token 后的剩余压力。 */
  const netTokens = pressureTokens - historyTokens;
  if (netTokens < threshold) {
    logger.step(
      `观察：净压力 ${netTokens} tokens（上下文压力 ${pressureTokens} − 已压缩块 ${historyTokens}）< 阈值 ${threshold}，跳过`,
    );
    return;
  }
  logger.step(
    `观察：净压力 ${netTokens} tokens（上下文压力 ${pressureTokens} − 已压缩块 ${historyTokens}）≥ 阈值 ${threshold}，触发压缩`,
  );
  /** 观察压缩区间（压缩边界之后；尾部保留 tailCount 条不压缩；无可行区间则跳过）。 */
  const range = computeCompressRange(session, tailCount);
  if (!range) {
    logger.step('观察：无可行压缩区间（边界后消息过短或配对无法平衡），跳过');
    return;
  }
  logger.step(
    `观察：压缩区间 [${range.start}..${range.end}]，遮蔽 ${range.shadowedSeqs.length} 个表层节点`,
  );
  /** 实际被替换的新消息表层节点（压缩边界之后；旧块不进入遮蔽、不被重写）。 */
  const replaceSeqs = range.shadowedSeqs;
  /** 替换区间起点（首个新消息节点；区间内全部为块时无新消息可压缩）。 */
  const replaceStart = replaceSeqs[0];
  if (replaceStart === undefined) {
    logger.step('观察：区间内无新消息（全部为压缩日志块），跳过');
    return;
  }
  /** 被替换 seq 集合（计算新消息 index 覆盖区间）。 */
  const shadowedSet = new Set(replaceSeqs);
  /** 压缩区间内的完整消息（连续性校验的预期覆盖区间）。 */
  const inRangeCms = indexCompleteMessages(session).filter((cm) =>
    cm.seqs.every((seq) => shadowedSet.has(seq)),
  );
  if (inRangeCms.length === 0) {
    logger.step('观察：区间内无完整消息，跳过');
    return;
  }
  /** 新消息起始/结束完整消息 index（模型输入携带绝对 index，校验按此区间约束）。 */
  const startIndex = inRangeCms[0]?.index ?? 0;
  const endIndex = inRangeCms[inRangeCms.length - 1]?.index ?? startIndex;
  logger.step(
    `观察：保留旧块 ${blocks.length} 条，替换新消息 [${replaceSeqs[0]}..${range.end}]（${replaceSeqs.length} 条），尾部保留 ${tailCount} 条（不压缩、不进日志），新消息 index ${startIndex}..${endIndex}`,
  );
  /** 共享提示词（观察/反思同一套）。 */
  const instruction = buildHistoryPrompt();
  /** 渲染输入：本次要压缩的完整消息（合法 <history> 块，含绝对 index；不含尾部；系统消息渲染为 <sys> 空块）。 */
  const contextText = renderMessages(session, replaceSeqs);
  /** 本次压缩生命周期（compactionId + 当前轮次；start 在摘要调用前开启，UI 压缩中提示）。 */
  const lifecycle: CompactionLifecycle = {
    compactionId: newCompactionId(),
    turn: openTurnOf(session),
  };
  try {
    logger.step('观察：追加 compaction/start（摘要调用前开启压缩中提示）');
    appendCompactionStart(session, lifecycle, 'observe');
  } catch (error) {
    /** 启动失败信息（统一字符串）。 */
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`观察压缩启动失败: ${message}`);
    return;
  }
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
    {
      maxAttempts: config.compressRetryCount + 1,
      expected: { start: startIndex, end: endIndex },
      rateLimitWaitMs: config.rateLimitWaitMs,
    },
  );
  if (summaryResult === null || summaryResult.text.trim().length === 0) {
    logger.step('观察：摘要调用失败/无输出，追加 compaction/end(error)');
    try {
      appendCompactionEnd(session, lifecycle, '摘要调用失败/无输出');
    } catch {
      /* end 追加失败忽略（start 已记录，日志仍可诊断） */
    }
    return;
  }
  /** 观察摘要文本（独立新块；旧块保留，不再合并）。 */
  const report = summaryResult.text;
  /** 摘要重试次数（0 起；首次尝试即成功为 0）。 */
  const attemptCount = summaryResult.attemptCount - 1;
  /** 摘要 token usage（归入主会话记录；无则省略）。 */
  const usage = summaryResult.usage;
  /** 被替换表层节点的 token 估算合计（仅新消息区间）。 */
  const shadowedTokenCount = replaceSeqs.reduce((total, seq) => {
    /** 当前表层事件。 */
    const event = session.events[seq];
    /** 事件对应的消息（用于 token 估算）。 */
    const message = event ? session.deriveEventMessage(event) : null;
    return total + (message ? ctx.tokenMeter.estimateMessage(message) : 0);
  }, 0);
  /** 被替换消息的字符数合计（压缩前文本长度；UI 标题统计用，递归计入 tool-result 内嵌文本）。 */
  const shadowedCharCount = replaceSeqs.reduce((total, seq) => {
    /** 当前表层事件。 */
    const event = session.events[seq];
    /** 事件对应的消息（取文本块字符数）。 */
    const message = event ? session.deriveEventMessage(event) : null;
    return total + (message ? textCharCount(message) : 0);
  }, 0);
  try {
    logger.step('观察提交：追加 compaction/summary（影子价格认领）');
    /** compaction/summary 事件 seq（承担影子价格认领，紧随其后的替换消息消费）。 */
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
  /** 尾部保留条数（config.tailMessageCount，缺省 10）。 */
  const tailCount = config.tailMessageCount;
  // 先反思（压缩过往摘要），后观察（压缩新消息，有必要才做）
  logger.step('反思 pass 开始');
  await reflectPass(ctx, agent, config, target, signal);
  logger.step('反思 pass 结束，观察 pass 开始');
  await observePass(ctx, agent, config, tailCount, target, signal);
  logger.step('观察 pass 结束，压缩流程完成');
}
