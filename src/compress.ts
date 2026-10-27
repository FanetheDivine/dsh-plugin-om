/**
 * 两级自动压缩（观察/反思）与 compaction 生命周期提交。
 * 导出 estimateTextTokens / isPairBalancedAfter / computeCompressRange / historySection /
 * historyTextOf / archivedHistoryTextOf / findObservePending / prepareObserveCompression / commitObserveCompression /
 * reflectPass / commitReflection / observePass / maybeCompress。
 *
 * - 摘要生成走工具驱动的压缩循环（compress-loop.ts runCompressionLoop）：首条 user
 *   消息仅含压缩指令与 start/end 区间，模型经 getHistory / compressHistory /
 *   completeCompression 工具完成压缩；最终 <history> 块由插件从视图与替换记录构建，
 *   全程无需整块校验
 * - 反思（异步归档）：<history> 块 token 合计（估算 × 换算系数，不计 archived-history）
 *   ≥ reflectThresholdTokens 时，保留合计不超过阈值 1/3 的尾部块（至少 1 个），其余块在
 *   后台归档为一个 <archived-history> 块（reflect.ts）；完成后的首个有输入的 pre-step 提交
 *   替换，并把被归档块中的 skill 以 skill-invocation 消息注入本 step；失败只记
 *   compaction/end(error)，块集合变化后重试
 * - 观察（打标记 → 对账 → 到期注入）：净压力（换算系数 × 未压缩表层估算，未压缩 =
 *   表层 − 已压缩块 − 系统提示词估算）首次 ≥ observeThresholdTokens 时记录待定标记
 *   （触发点 = 当时的最后一条完整消息 index），并立即开始后台预压缩（precompress.ts，
 *   结果写 om/observe-summary 信封、不做替换）；每个 pre-step 对账保证活跃标记对应任务
 *   或持久化结果（重启恢复直接采纳信封、不重压缩；失败任务丢弃重启）；新增完整消息数 ≥
 *   tailMessageCount 时到期，把压缩边界至触发点的全部消息作为压缩视图注入为新 <history>
 *   块（旧块保留），等待期间的新消息成为下一轮未压缩尾部（延迟窗口内压力允许短暂超
 *   阈值）；到期未完成时阻塞等待后台任务（turn 取消则放行不注入，任务继续后台）；
 *   tailMessageCount=0 时触发当轮即到期，阻塞等待注入
 * - 两个阈值都按主模型真实 token 计；换算系数 = 上次请求真实用量基线 ÷ 锚点估算
 *   （工具定义估算 + 锚点表层），无真实用量基线或计量失败按 1 计
 * - 待定标记与压缩结果以 ignorable 的 plugin record（kind 为
 *   om/observe-pending / om/observe-invalidate / om/observe-summary，见 om-event.ts）
 *   持久化在会话日志中（重启后从日志恢复）；压缩失败保留待定，下个 pre-step 重启任务重试
 * - pre-step 先做反思检查（只启动或跳过，不阻塞），再执行观察（压缩主体在后台运行，
 *   pre-step 仅在到期结果未就绪时阻塞等待）；仅主会话生效；关闭包根行即停用
 * - 压缩目标默认跟随会话路由；compressProvider + compressModel 成对配置时覆盖路由
 *   （成对配置下未路由会话也执行压缩）；compressReasoningEffort 配置时压缩前经
 *   ctx.llm.resolveModelInfo 校验目标模型 reasoning.efforts（按 provider+model 缓存），
 *   未命中 / 无元数据 / 查询失败降级为模型默认并报告 reasoning-effort-unavailable 降级
 * - 压缩边界：最后一个合法 <history> 或 <archived-history> 块之后的消息视为未压缩，其前不重复压缩
 * - 观察压缩循环最终失败（连续无工具调用 / 请求级错误）时 pass 返回失败结果（携带最后一次
 *   错误），压缩流程向上传播，pre-step 据此拒绝本 step 中断当前 turn；signal 中止标记
 *   aborted（不中断）；成功与失败均落盘压缩会话记录子会话（失败时其 id 随结果传播为
 *   诊断子会话 id）
 * - 提交走宿主 compaction/* 生命周期事件（start 带 phase → summary → 替换消息 → end），
 *   失败补 end(error，实际报错 + 诊断子会话 sessionId)；替换消息 source 标记插件标识供 UI 认领
 * - 挂载失败类问题（systemPrompt/tokenMeter 服务异常）始终 console 到外部进程，并追加
 *   ignorable 的 om 警告 plugin record（客户端渲染功能降级警告行，每会话同一
 *   问题至多一次）；
 *   辅助估算的普通运行时报错仅记日志。降级与报错都不阻塞压缩（tokenMeter 计量失败时
 *   本轮跳过观察，反思换算系数按 1 计）
 */
import { CompactionId } from '@deepseek-ai/dsh-compaction';
import { createUserMessage, type ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { scopeOf } from '@deepseek-ai/dsh-scope';
import { SessionSeq } from '@deepseek-ai/dsh-session';
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt';
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt';
import type { CompressionStats, CompressionSuccess } from './compress-loop.ts';
import { buildArchiveView, buildObserveView, type CompressionView } from './compress-view.ts';
import {
  ARCHIVED_HISTORY_TAG,
  HISTORY_TAG,
  isPluginOwnedSource,
  omSource,
  SKILL_INVOCATION_KIND,
  SKILL_TOOL_NAME,
} from './constants.ts';
import { reportDegrade } from './degrade.ts';
import { indexCompleteMessages, surfaceIndexOf } from './log-index.ts';
import type { PluginLogger } from './logger.ts';
import { makeLogger } from './logger.ts';
import { findOmEvents, readOmEvent } from './om-event.ts';
import { appendOmEvent } from './om-event-append.ts';
import {
  type AdoptedSummary,
  adoptPersistedSummary,
  disposePrecompression,
  findPrecompressionJob,
  startPrecompression,
} from './precompress.ts';
import {
  disposeReflection,
  historyBlocksKey,
  peekReflectJob,
  type ReflectJob,
  reflectFailedKey,
  selectArchiveBlocks,
  startReflection,
  takeReflectJob,
} from './reflect.ts';
import type {
  Agent,
  CompactionEndPayload,
  CompactionStartPayload,
  CompactionSummaryPayload,
  Context,
  PluginConfig,
  Session,
  SessionEvent,
  TokenUsage,
  UserMessage,
} from './types.ts';
import { blocksToText, type RoutedTarget, routedTarget, seqsCharCount, uuid } from './utils.ts';

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
 * 压缩目标解析：compressProvider + compressModel 成对配置时覆盖会话路由；仅配置单键或
 * 未配置时回落 routedTarget（会话未路由返回 undefined，压缩跳过——成对覆盖配置下
 * 未路由会话仍可压缩）。
 */
export function compressionTarget(
  config: Readonly<PluginConfig>,
  session: Session,
): RoutedTarget | undefined {
  if (config.compressProvider !== undefined && config.compressModel !== undefined) {
    return { provider: config.compressProvider, model: config.compressModel };
  }
  return routedTarget(session);
}

/** 压缩思考等级校验缓存：provider+model → 命中的等级 id（undefined 表示降级为模型默认）。 */
const compressionEffortCache = new Map<string, ReasoningEffortId | undefined>();

/** 清空压缩思考等级校验缓存（按目标缓存 resolveModelInfo 查询结果；测试隔离用）。 */
export function clearCompressionModelInfoCache(): void {
  compressionEffortCache.clear();
}

/**
 * 校验配置的 compressReasoningEffort 并解析为压缩请求的思考等级：未配置返回 undefined
 * （用模型默认，不查询模型信息）；命中目标模型 reasoning.efforts 返回等级 id；
 * 不在可选等级 / 模型无 reasoning 元数据 / 查询抛错时返回 undefined 并报告
 * reasoning-effort-unavailable 降级。结果按 provider+model 缓存（含降级结果），避免
 * 每个 pre-step 重复查询。
 */
export async function resolveCompressionEffort(
  ctx: Context,
  session: Session,
  config: Readonly<PluginConfig>,
  target: RoutedTarget,
  logger: PluginLogger,
): Promise<ReasoningEffortId | undefined> {
  const configured = config.compressReasoningEffort;
  if (configured === undefined) return undefined;
  const cacheKey = `${target.provider}\n${target.model}`;
  if (compressionEffortCache.has(cacheKey)) return compressionEffortCache.get(cacheKey);
  let resolved: ReasoningEffortId | undefined;
  try {
    const info = await ctx.llm.resolveModelInfo(target.provider, target.model);
    const efforts = info?.reasoning?.efforts;
    if (Array.isArray(efforts) && efforts.some((effort) => effort?.id === configured)) {
      resolved = configured as ReasoningEffortId; // 品牌类型由本处校验担保
      logger.step(`压缩思考等级校验通过：${configured}`);
    } else {
      reportDegrade(session, logger, 'reasoning-effort-unavailable');
      logger.warn(
        `compressReasoningEffort=${configured} 不在模型 ${target.provider}/${target.model} 的可选思考等级中，使用模型默认`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reportDegrade(session, logger, 'reasoning-effort-unavailable');
    logger.warn(`压缩思考等级校验失败（${message}），使用模型默认`);
  }
  compressionEffortCache.set(cacheKey, resolved);
  return resolved;
}

/** 插件自产 user/message 的文本；其余事件返回 undefined。 */
function pluginOwnedText(event: SessionEvent | undefined): string | undefined {
  if (event?.type !== 'user/message') return undefined;
  if (!isPluginOwnedSource(event.data.source)) return undefined;
  return blocksToText(event.data.content);
}

/**
 * 判定消息是否为本插件的归档块消息并返回整段文本：插件自产且文本以
 * <archived-history> 开标签起始；其余返回 undefined。
 */
export function archivedHistoryTextOf(event: SessionEvent | undefined): string | undefined {
  const text = pluginOwnedText(event);
  if (text === undefined) return undefined;
  const head = text.trimStart();
  const open = `<${ARCHIVED_HISTORY_TAG}`;
  if (!head.startsWith(open)) return undefined;
  const next = head.charAt(open.length);
  return next === '>' || next === ' ' ? text : undefined;
}

/**
 * 判定消息是否为本插件的压缩日志消息并提取日志文本（按 source 标记判断，兼容旧宿主
 * checkpoint 标记 'compact'）。仅当消息文本含 <history> 开标签且不是归档块时视为压缩
 * 日志，返回整段文本；其余返回 undefined。
 */
export function historyTextOf(event: SessionEvent | undefined): string | undefined {
  const text = pluginOwnedText(event);
  if (text === undefined || archivedHistoryTextOf(event) !== undefined) return undefined;
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
    const event = session.snapshotEvents()[node];
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
 * 观察压缩区间：压缩边界后的首个表层节点（无边界时从首个非 system/message 头节点的
 * 表层节点起）→ 触发点完整消息（endMessageIndex）对应的表层终点（取该完整消息最后
 * 一个事件 seq 在表层中的位置）；区间终点回退到 tool-call/result 配对平衡点（不切段）。
 * 触发点完整消息不存在或其事件已不在表层（被后续压缩遮蔽）时返回 undefined。
 * 返回区间起止表层 seq 与被遮蔽 seq 列表。
 */
export function computeCompressRange(
  session: Session,
  endMessageIndex: number,
): { start: number; end: number; shadowedSeqs: number[] } | undefined {
  const surface = [...session.surface.nodes];
  if (surface.length === 0) return undefined;
  const { boundarySeq } = historySection(session);
  // 区间起点 = 压缩边界在表层顺序中的后继第一条消息（替换块追加在日志末尾，
  // seq 大于被遮蔽消息，须按表层顺序而非 seq 比较取「边界之后」）。
  // 表层节点 0 为 system/message（系统提示词）时起点至少为 1：宿主禁止非
  // system/message 的替换操作覆盖该节点（与 compaction-basic 选区语义一致）。
  const headSeq = surface[0];
  const headEvent = headSeq === undefined ? undefined : session.snapshotEvents()[headSeq];
  const headOffset = headEvent?.type === 'system/message' ? 1 : 0;
  const startIdx =
    boundarySeq === undefined ? headOffset : surface.indexOf(SessionSeq(boundarySeq)) + 1;
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
 * 压缩边界（historySection）：扫描表层全部节点，分别收集合法 <history> 块与
 * <archived-history> 归档块（内文 + seq，按表层顺序），并以两类块中表层位置最后的
 * 一个作为压缩边界——边界之后的消息视为未压缩，其前（含边界自身）视为已压缩。
 * 无压缩块时 blocks / archived 为空、boundarySeq 为 undefined。
 */
export function historySection(session: Session): {
  blocks: Array<{ text: string; seq: number }>;
  archived: Array<{ text: string; seq: number }>;
  boundarySeq: number | undefined;
} {
  const blocks: Array<{ text: string; seq: number }> = [];
  const archived: Array<{ text: string; seq: number }> = [];
  let boundarySeq: number | undefined;
  const events = session.snapshotEvents();
  for (const seq of session.surface.nodes) {
    const event = events[seq];
    const archivedText = archivedHistoryTextOf(event);
    if (archivedText !== undefined) {
      archived.push({ text: archivedText, seq });
      boundarySeq = seq;
      continue;
    }
    const text = historyTextOf(event);
    if (text === undefined) continue;
    blocks.push({ text, seq });
    boundarySeq = seq;
  }
  return { blocks, archived, boundarySeq };
}

/**
 * 查找当前活跃的观察压缩待定标记：按日志顺序取最后一条 om/observe-pending 信封事件，
 * 其后须无引用它的 om/observe-invalidate（已失效），且其后的压缩边界 seq 不大于标记
 * seq（边界后移说明标记期间已发生过压缩，标记过期——兜底「执行成功但失效标记未写出」
 * 的崩溃窗口）。无活跃标记返回 undefined。
 */
export function findObservePending(
  session: Session,
): { seq: number; triggerMessageIndex: number } | undefined {
  let pending: { seq: number; triggerMessageIndex: number } | undefined;
  for (let seq = 0; seq < session.snapshotEvents().length; seq += 1) {
    const event = session.snapshotEvents()[seq];
    if (!event) continue;
    const om = readOmEvent(event);
    if (om?.kind === 'om/observe-pending') {
      pending = { seq, triggerMessageIndex: om.data.triggerMessageIndex };
    } else if (
      om?.kind === 'om/observe-invalidate' &&
      pending !== undefined &&
      om.data.pendingSeq === pending.seq
    ) {
      pending = undefined;
    }
  }
  if (pending === undefined) return undefined;
  const { boundarySeq } = historySection(session);
  if (boundarySeq !== undefined && boundarySeq > pending.seq) return undefined;
  return pending;
}

/** 追加观察压缩待定标记（log-only om 信封事件）：记录触发点完整消息 index，返回事件 seq。 */
function appendObservePending(session: Session, triggerMessageIndex: number): number {
  return appendOmEvent(session, 'om/observe-pending', { triggerMessageIndex });
}

/** 追加观察压缩待定失效标记（log-only om 信封事件）：声明指定 pending 已失效，返回事件 seq。 */
function appendObserveInvalidate(session: Session, pendingSeq: number): number {
  return appendOmEvent(session, 'om/observe-invalidate', { pendingSeq });
}

/** 当前打开中的 turn 号（最近 turn/start 且未被 turn/end 关闭）；无则 null。 */
function openTurnOf(session: Session): number | null {
  let turn: number | null = null;
  for (const event of session.snapshotEvents()) {
    if (event.type === 'turn/start') turn = event.data.turn;
    else if (event.type === 'turn/end') turn = null;
  }
  return turn;
}

/** 生成宿主 compaction 生命周期 id（经宿主品牌构造函数标注）。 */
function newCompactionId(): CompactionId {
  return CompactionId(uuid());
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
 * summary 为完整合并后的 <history> 内文；usage 由摘要调用提取（无则省略）；stats 提供
 * 压缩循环计时（startedAt/completedAt/durationMs）。
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
    /** 压缩循环统计（载荷记录其计时字段）。 */
    stats: CompressionStats;
    usage?: TokenUsage;
    /** 摘要请求实际使用的思考等级（未配置或降级为模型默认时省略）。 */
    reasoningEffort?: ReasoningEffortId;
  },
): number {
  const payload: CompactionSummaryPayload = {
    compactionId: data.lifecycle.compactionId,
    summary: [{ type: 'text', text: data.summary }],
    shadowedRange: {
      start: SessionSeq(data.shadowedRange.start),
      end: SessionSeq(data.shadowedRange.end),
    },
    shadowedSeqs: data.shadowedSeqs.map(SessionSeq),
    shadowedTokenCount: data.shadowedTokenCount,
    shadowedCharCount: data.shadowedCharCount,
    provider: data.provider,
    model: data.model,
    ...(data.maxTokens === undefined ? {} : { maxTokens: data.maxTokens }),
    startedAt: data.stats.startedAt,
    completedAt: data.stats.completedAt,
    durationMs: data.stats.durationMs,
    ...(data.usage === undefined ? {} : { usage: data.usage }),
    ...(data.reasoningEffort === undefined ? {} : { reasoningEffort: data.reasoningEffort }),
  };
  return session.append('compaction/summary', payload).seq;
}

/**
 * 追加 compaction/end（log-only，结束生命周期；error 记录失败原因，
 * diagnosticSessionId 记录最后一次摘要尝试（无论成功或失败）的诊断子会话 id，
 * durationMs 记录失败路径的压缩循环耗时）。
 */
function appendCompactionEnd(
  session: Session,
  lifecycle: CompactionLifecycle,
  error?: string,
  diagnosticSessionId?: string,
  durationMs?: number,
): number {
  const payload: CompactionEndPayload = {
    compactionId: lifecycle.compactionId,
    turn: lifecycle.turn,
    ...(error === undefined ? {} : { error }),
    ...(diagnosticSessionId === undefined ? {} : { diagnosticSessionId }),
    ...(durationMs === undefined ? {} : { durationMs }),
  };
  return session.append('compaction/end', payload).seq;
}

/** 追加 <history> 压缩日志消息（surfaceOp 替换遮蔽区间，source 标记插件自产 + compactionId）。 */
function appendHistoryMessage(
  session: Session,
  content: string,
  sourceEventSeqs: number[],
  surfaceOp: { op: 'replace'; startSeq: number; endSeq: number },
  compactionId: CompactionId,
): void {
  const message = createUserMessage({
    content: [{ type: 'text', text: content }],
    source: omSource(compactionId),
  });
  session.append('user/message', message, {
    surfaceOp: {
      op: 'replace',
      startSeq: SessionSeq(surfaceOp.startSeq),
      endSeq: SessionSeq(surfaceOp.endSeq),
    },
    sourceEventSeqs: sourceEventSeqs.map(SessionSeq),
  });
}

/**
 * 反思（异步归档）检查：每个 pre-step 在观察前调用，不阻塞、不失败。
 * - 有运行中或待提交任务：跳过（待提交任务由 commitReflection 提交）
 * - 有失败任务：写 compaction/start + end(error) 后移除
 * - 无任务：history 块 token 合计（估算 × 换算系数）≥ reflectThresholdTokens 时，
 *   保留合计不超过阈值 1/3 的尾部块（至少 1 个），其余归档，启动后台反思；
 *   同一块集合上次失败则不重试
 */
export function reflectPass(
  ctx: Context,
  agent: Agent,
  config: Readonly<PluginConfig>,
  target: RoutedTarget,
  reasoningEffort?: ReasoningEffortId,
): void {
  const session = agent.session;
  const logger = makeLogger(ctx, config.debug);
  const job = peekReflectJob(session.id);
  if (job !== undefined && job.session !== session) {
    disposeReflection(session.id);
  } else if (job?.state === 'failed') {
    takeReflectJob(session.id);
    recordReflectFailure(session, job, logger);
    return;
  } else if (job !== undefined) {
    logger.step(job.state === 'running' ? '反思：后台任务运行中，跳过' : '反思：结果待提交，跳过');
    return;
  }
  startReflectionIfNeeded(ctx, session, config, target, reasoningEffort, logger);
}

/**
 * 提交已完成的反思（pre-step 在 next() 之后、本 step 有待输入消息时调用）：
 * 校验被归档块仍在表层且相邻后写 compaction/start → summary → 替换为 archived-history → end，
 * 返回需追加到本 step 的 skill 注入消息。无待提交任务、校验或提交失败返回空数组。
 */
export function commitReflection(
  ctx: Context,
  agent: Agent,
  config: Readonly<PluginConfig>,
): UserMessage[] {
  const session = agent.session;
  const job = peekReflectJob(session.id);
  if (job === undefined || job.state !== 'done') return [];
  takeReflectJob(session.id);
  if (job.session !== session) return [];
  return commitReflectJob(session, job, config, makeLogger(ctx, config.debug));
}

/** 触发检查：达到阈值且有可归档块时启动后台反思。 */
function startReflectionIfNeeded(
  ctx: Context,
  session: Session,
  config: Readonly<PluginConfig>,
  target: RoutedTarget,
  reasoningEffort: ReasoningEffortId | undefined,
  logger: PluginLogger,
): void {
  const threshold = config.reflectThresholdTokens;
  logger.step(`反思检查（反思阈值 ${threshold} tokens）`);
  const { blocks } = historySection(session);
  if (blocks.length < 2) {
    logger.step(`反思：<history> 块 ${blocks.length} 个，无可归档块，跳过`);
    return;
  }
  const key = historyBlocksKey(blocks);
  if (reflectFailedKey(session.id) === key) {
    logger.step('反思：上次失败后 <history> 块未变化，跳过');
    return;
  }
  const estimatedTotal = blocks.reduce((total, block) => total + estimateTextTokens(block.text), 0);
  // 阈值按主模型真实 token 计：估算 × 换算系数（计量失败按系数 1 继续）
  const measurement = measurePressure(ctx, session, logger);
  const ratio =
    measurement === undefined
      ? 1
      : conversionRatio(measurement, estimateToolsTokens(session, logger));
  const tokens = Math.round(ratio * estimatedTotal);
  const detail = `${tokens} tokens（估算 ${estimatedTotal} × 换算系数 ${ratio.toFixed(2)}）`;
  if (tokens < threshold) {
    logger.step(`反思：<history> 块 ${detail} < 阈值 ${threshold}，跳过`);
    return;
  }
  const { archived, kept } = selectArchiveBlocks(
    blocks,
    (block) => ratio * estimateTextTokens(block.text),
    threshold / 3,
  );
  if (archived.length === 0) {
    logger.step('反思：尾部保留预算覆盖全部块，无可归档块，跳过');
    return;
  }
  const { view, skills } = buildArchiveView(archived);
  if (view.minIndex === undefined || view.maxIndex === undefined) {
    logger.step('反思：被归档块内无可定位条目（历史遗留块），跳过');
    return;
  }
  startReflection({
    ctx,
    session,
    config,
    target,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    key,
    archived,
    view,
    skills,
    estimatedTokens: archived.reduce((total, block) => total + estimateTextTokens(block.text), 0),
    shadowedCharCount: archived.reduce(
      (total, block) => total + historyInnerText(block.text).length,
      0,
    ),
  });
  logger.info(
    `反思：<history> 块 ${detail} ≥ 阈值 ${threshold}，后台归档 ${archived.length} 个块，保留 ${kept.length} 个`,
  );
}

/** 失败任务：在当前开放 turn 内写 compaction/start + end(error)；中止的任务不记录。 */
function recordReflectFailure(session: Session, job: ReflectJob, logger: PluginLogger): void {
  const failure = job.failure;
  if (failure === undefined || failure.aborted) return;
  const lifecycle: CompactionLifecycle = {
    compactionId: newCompactionId(),
    turn: openTurnOf(session),
  };
  try {
    appendCompactionStart(session, lifecycle, 'reflect');
    appendCompactionEnd(session, lifecycle, failure.error, failure.diagnosticSessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`反思失败记录追加失败: ${message}`);
  }
}

/** 被归档块仍在表层且在表层顺序中相邻。 */
function archivedBlocksIntact(session: Session, job: ReflectJob): boolean {
  const nodes = session.surface.nodes;
  const first = job.archived[0];
  if (first === undefined) return false;
  const start = nodes.indexOf(SessionSeq(first.seq));
  if (start < 0) return false;
  return job.archived.every((block, i) => nodes[start + i] === block.seq);
}

/** 提交成功任务；返回需注入的 skill 消息（表层已有同名 skill 的不注入）。 */
function commitReflectJob(
  session: Session,
  job: ReflectJob,
  config: Readonly<PluginConfig>,
  logger: PluginLogger,
): UserMessage[] {
  const result = job.result;
  const first = job.archived[0];
  const last = job.archived[job.archived.length - 1];
  if (result === undefined || first === undefined || last === undefined) return [];
  if (!archivedBlocksIntact(session, job)) {
    logger.info('反思：被归档块已不在表层或不再相邻，丢弃本次结果');
    return [];
  }
  const blockSeqs = job.archived.map((block) => block.seq);
  const lifecycle: CompactionLifecycle = {
    compactionId: newCompactionId(),
    turn: openTurnOf(session),
  };
  try {
    appendCompactionStart(session, lifecycle, 'reflect');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`反思提交启动失败: ${message}`);
    return [];
  }
  try {
    const summarySeq = appendCompactionSummary(session, {
      lifecycle,
      summary: result.text,
      shadowedRange: { start: first.seq, end: last.seq },
      shadowedSeqs: blockSeqs,
      // 影子价格为宿主计价协议，保持字符/4 估算单位（不乘换算系数）
      shadowedTokenCount: job.estimatedTokens,
      shadowedCharCount: job.shadowedCharCount,
      provider: job.target.provider,
      model: job.target.model,
      maxTokens: config.compressMaxTokens,
      stats: result.stats,
      ...(result.usage === undefined ? {} : { usage: result.usage }),
      ...(job.reasoningEffort === undefined ? {} : { reasoningEffort: job.reasoningEffort }),
    });
    appendHistoryMessage(
      session,
      result.text,
      [summarySeq, ...blockSeqs],
      { op: 'replace', startSeq: first.seq, endSeq: last.seq },
      lifecycle.compactionId,
    );
    appendCompactionEnd(session, lifecycle, undefined, result.recordSessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`反思提交失败: ${message}`);
    try {
      appendCompactionEnd(session, lifecycle, message, undefined, result.stats.durationMs);
    } catch {
      /* end 追加失败忽略（start 已记录，日志仍可诊断） */
    }
    return [];
  }
  const live = liveSkillNames(session);
  const messages = job.skills
    .filter((skill) => !live.has(skill.name))
    .map((skill) =>
      createUserMessage({
        content: [{ type: 'text', text: skill.content }],
        source: { kind: SKILL_INVOCATION_KIND, name: skill.name, form: 'instructions' },
      }),
    );
  logger.info(
    `反思提交：${job.archived.length} 个 <history> 块归档为 archived-history，注入 ${messages.length} 个 skill`,
  );
  return messages;
}

/** 表层中仍以 skill 形态存在的名称：history 块内 skill_content、手动加载消息、skill 工具调用。 */
function liveSkillNames(session: Session): Set<string> {
  const names = new Set<string>();
  const events = session.snapshotEvents();
  for (const seq of session.surface.nodes) {
    const event = events[seq];
    if (event === undefined) continue;
    const history = historyTextOf(event);
    if (history !== undefined) {
      for (const match of history.matchAll(/<skill_content name="([^"]*)"/g)) {
        names.add(unescapeAttr(match[1] ?? ''));
      }
      continue;
    }
    if (event.type === 'user/message') {
      const source = event.data.source;
      if (source.kind === SKILL_INVOCATION_KIND && typeof source.name === 'string') {
        names.add(source.name);
      }
      continue;
    }
    if (event.type === 'assistant/message') {
      for (const block of event.data.message.content) {
        if (block.type !== 'tool-call' || block.name !== SKILL_TOOL_NAME) continue;
        const name = skillArgName(block.arguments);
        if (name !== undefined) names.add(name);
      }
    }
  }
  return names;
}

/** skill 工具调用参数中的 name；参数非法时 undefined。 */
function skillArgName(args: string): string | undefined {
  try {
    const parsed: { name?: string } | null = JSON.parse(args);
    return typeof parsed?.name === 'string' ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}

/** XML 属性值反转义。 */
function unescapeAttr(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

/**
 * 估算系统提示词 tokens：按 agent 作用域组装并渲染系统提示词，按长度/4 启发式计。
 * systemPrompt 服务经 ctx.get 容错读取（ctx 属性访问在服务未挂载时抛错）；服务缺失
 * 或组装/渲染失败时按 0 计——只影响观察触发时机（偏早触发），不阻塞压缩。
 * 服务缺失属挂载失败：console 外部 + om 警告事件每会话报告一次；组装失败仅记日志。
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

/** tokenMeter.measure 结果中计算净压力与换算系数所需的字段。 */
interface PressureMeasurement {
  /** 当前表层路由计价 token 合计（不含工具定义）。 */
  surfaceTokens: number;
  /** 当前表层相对锚点请求表层的有符号重计价差。 */
  surfaceDeltaTokens: number;
  /** 基线为真实用量时的 usage tokens；估算基线或无基线为 undefined。 */
  baselineUsageTokens: number | undefined;
}

/**
 * 读取压力计量（tokenMeter.measure）。调用异常时记日志并报告降级（console 外部 +
 * om 警告事件每会话一次），返回 undefined——观察本轮跳过（无压力数据不触发），
 * 反思换算系数按 1 计；都不阻塞 turn。
 */
function measurePressure(
  ctx: Context,
  session: Session,
  logger: PluginLogger,
): PressureMeasurement | undefined {
  try {
    const measurement = ctx.tokenMeter.measure(session);
    return {
      surfaceTokens: measurement.surfaceTokens,
      surfaceDeltaTokens: measurement.surfaceDeltaTokens,
      baselineUsageTokens:
        measurement.baseline.kind === 'usage' ? measurement.baseline.tokens : undefined,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`上下文压力读取失败（tokenMeter.measure 抛错）: ${message}`);
    reportDegrade(session, logger, 'tokenMeter-unavailable');
    return undefined;
  }
}

/** 观察压缩准备产物：区间、替换 seq 列表、字符统计与压缩视图。 */
export type ObservePrepared = {
  /** 压缩区间（start/end 为表层 seq，含端点）。 */
  range: { start: number; end: number; shadowedSeqs: number[] };
  /** 被替换的表层 seq 列表（= range.shadowedSeqs）。 */
  replaceSeqs: number[];
  /** 替换区间起点（replaceSeqs 首项）。 */
  replaceStart: number;
  /** 被遮蔽区间字符数（压缩循环 originalChars）。 */
  shadowedCharCount: number;
  /** 压缩视图（压缩循环的输入；准备成功后 min/max 必可定位）。 */
  view: CompressionView & { minIndex: number; maxIndex: number };
};

/** 观察压缩准备结果：ok=false 时 reason 说明无可行区间原因（调用方清除待定标记视为完成）。 */
export type ObservePrepareResult =
  | { ok: true; prepared: ObservePrepared }
  | { ok: false; reason: string };

/**
 * 换算系数：上次请求真实用量基线 ÷ 锚点估算量（工具定义估算 + 锚点表层 =
 * 当前表层 − 表层增量），把字符/4 估算换算为主模型真实 token 单位。无真实用量
 * 基线或锚点估算量非正时按 1 计；结果恒 ≥ 1（真实用量低于估算时宿主已回退估算基线）。
 */
function conversionRatio(measurement: PressureMeasurement, toolsTokens: number): number {
  if (measurement.baselineUsageTokens === undefined) return 1;
  const anchorTokens = toolsTokens + measurement.surfaceTokens - measurement.surfaceDeltaTokens;
  if (anchorTokens <= 0) return 1;
  return Math.max(1, measurement.baselineUsageTokens / anchorTokens);
}

/**
 * 准备观察压缩：计算区间 [压缩边界..触发点]、校验可行性并构建压缩视图。
 * 不写任何事件；供延迟执行与后台预压缩共用。
 */
export function prepareObserveCompression(
  session: Session,
  triggerMessageIndex: number,
  config: Readonly<PluginConfig>,
): ObservePrepareResult {
  const range = computeCompressRange(session, triggerMessageIndex);
  if (!range) {
    return {
      ok: false,
      reason: '无可行压缩区间（边界后无消息、触发点已被压缩或配对无法平衡）',
    };
  }
  const replaceSeqs = range.shadowedSeqs;
  const replaceStart = replaceSeqs[0];
  if (replaceStart === undefined) {
    return { ok: false, reason: '区间内无新消息（全部为压缩日志块）' };
  }
  const shadowedSet = new Set(replaceSeqs);
  const inRangeCms = indexCompleteMessages(session).filter((cm) =>
    cm.seqs.every((seq) => shadowedSet.has(seq)),
  );
  if (inRangeCms.length === 0) {
    return { ok: false, reason: '区间内无完整消息' };
  }
  const shadowedCharCount = seqsCharCount(session, replaceSeqs);
  const view = buildObserveView(session, replaceSeqs, {
    skipReasoning: config.compressSkipReasoning,
  });
  if (view.minIndex === undefined || view.maxIndex === undefined) {
    return { ok: false, reason: '区间内无可定位条目' };
  }
  const preparedView = { ...view, minIndex: view.minIndex, maxIndex: view.maxIndex };
  return {
    ok: true,
    prepared: { range, replaceSeqs, replaceStart, shadowedCharCount, view: preparedView },
  };
}

/** 观察压缩提交选项（目标、模型信息、日志与待定标记清理回调）。 */
type ObserveCommitOptions = {
  target: RoutedTarget;
  maxTokens: number | undefined;
  reasoningEffort: ReasoningEffortId | undefined;
  triggerNote: string;
  logger: PluginLogger;
  clearPending: () => void;
};

/**
 * 提交观察压缩结果：compaction/summary（影子价格认领）→ 替换被压缩区间为 <history>
 * 块（旧块保留）→ compaction/end → 清除待定标记。调用前须已追加 compaction/start
 * （同一开放 turn 内满足宿主括号不变量）。提交失败为局部异常（压缩已成功）：记日志、
 * 补 end(error) 后返回不失败结果，不中断 turn；待定标记保留，边界后移后由
 * findObservePending 判定过期。
 */
export function commitObserveCompression(
  ctx: Context,
  session: Session,
  lifecycle: CompactionLifecycle,
  prepared: ObservePrepared,
  summaryResult: CompressionSuccess,
  opts: ObserveCommitOptions,
): CompressPassResult {
  const { logger, clearPending, target, triggerNote } = opts;
  const { range, replaceSeqs, replaceStart, shadowedCharCount } = prepared;
  const report = summaryResult.text;
  const usage = summaryResult.usage;
  // 单条消息计价失败按 0 计（tokenMeter 异常属挂载类降级：console 外部 + om 警告事件每会话一次）
  const shadowedTokenCount = replaceSeqs.reduce((total, seq) => {
    const event = session.snapshotEvents()[seq];
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
      maxTokens: opts.maxTokens,
      stats: summaryResult.stats,
      ...(usage === undefined ? {} : { usage }),
      ...(opts.reasoningEffort === undefined ? {} : { reasoningEffort: opts.reasoningEffort }),
    });
    logger.step('观察提交：替换被压缩新消息区间为 <history>（旧块保留）');
    appendHistoryMessage(
      session,
      report,
      [summarySeq, ...replaceSeqs],
      {
        op: 'replace',
        startSeq: replaceStart,
        endSeq: range.end,
      },
      lifecycle.compactionId,
    );
    logger.step('观察提交：追加 compaction/end');
    appendCompactionEnd(session, lifecycle, undefined, summaryResult.recordSessionId);
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
      appendCompactionEnd(session, lifecycle, message, undefined, summaryResult.stats.durationMs);
    } catch {
      /* end 追加失败忽略（start 已记录，日志仍可诊断） */
    }
    return { failed: false };
  }
}

/** 匹配 pendingSeq 的最后一条持久化压缩结果信封（重启恢复采纳；正常每标记至多一条）。 */
function findPersistedSummary(session: Session, pendingSeq: number) {
  const matches = findOmEvents(session, 'om/observe-summary').filter(
    (event) => event.data.pendingSeq === pendingSeq,
  );
  return matches.at(-1);
}

/** 等待 signal 中止（无 signal 时返回永不 resolve 的 Promise，race 仅由任务完成决定）。 */
function signalAbortedRace(signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return new Promise<void>(() => {});
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/**
 * 观察（打标记 → 对账 → 到期注入）：每个 pre-step 串行执行三阶段。
 * 打标记：无活跃待定标记时测净压力 tokens（换算系数 × 未压缩表层估算，未压缩 =
 * 表层 − 已压缩 <history> 块估算合计 − 系统提示词估算），首次 ≥ observeThresholdTokens
 * 写 om/observe-pending（触发点 = 当时的最后一条完整消息 index）。
 * 对账：活跃标记必须对应后台任务或持久化结果——匹配 pendingSeq 的 om/observe-summary
 * 信封直接采纳（重启恢复，不重压缩）；无结果且无任务（或任务已失败）时启动后台预压缩
 * （无可行区间则失效标记视为完成）；无活跃标记时清理注册表（边界后移使标记过期的运行中
 * 任务被中止）。
 * 到期：新增完整消息数 ≥ tailMessageCount 时注入——已完成结果在同一 pre-step / 同一开放
 * turn 内一次提交（compaction/start → summary → 替换 → end → 失效标记，满足宿主括号
 * 不变量）；运行中任务等待其完成（turn 被取消则放行不注入，任务继续后台）；失败返回
 * 失败结果（error = 最后一次错误，标记保留，下个 pre-step 重启任务重试）。
 */
export async function observePass(
  ctx: Context,
  agent: Agent,
  config: Readonly<PluginConfig>,
  waitCount: number,
  target: RoutedTarget,
  signal?: AbortSignal,
  reasoningEffort?: ReasoningEffortId,
): Promise<CompressPassResult> {
  const session = agent.session;
  const logger = makeLogger(ctx, config.debug);
  logger.step(
    `观察检查（观察阈值 ${config.observeThresholdTokens} tokens，延迟等待 ${waitCount} 条完整消息）`,
  );
  const pending = findObservePending(session);

  // 阶段一：打标记——无活跃标记时评估净压力，首次越阈值写待定标记
  let triggerMessageIndex: number;
  let pendingSeq: number;
  if (pending === undefined) {
    // 无活跃标记（含边界后移使标记过期、已失效）：清理注册表中可能残留的孤儿任务
    disposePrecompression(session.id);
    const threshold = config.observeThresholdTokens;
    const measurement = measurePressure(ctx, session, logger);
    if (measurement === undefined) return { failed: false };
    const { blocks, archived } = historySection(session);
    const historyTokens = [...blocks, ...archived].reduce(
      (total, block) => total + estimateTextTokens(block.text),
      0,
    );
    const systemTokens = await estimateSystemPromptTokens(ctx, agent, logger, signal);
    const toolsTokens = estimateToolsTokens(session, logger);
    const ratio = conversionRatio(measurement, toolsTokens);
    const uncompressedTokens = Math.max(
      0,
      measurement.surfaceTokens - historyTokens - systemTokens,
    );
    const netTokens = Math.round(ratio * uncompressedTokens);
    const formula = `换算系数 ${ratio.toFixed(2)} ×（表层 ${measurement.surfaceTokens} − 已压缩块 ${historyTokens} − 系统提示词 ${systemTokens}）`;
    if (netTokens < threshold) {
      logger.step(`观察：净压力 ${netTokens} tokens（${formula}）< 阈值 ${threshold}，跳过`);
      return { failed: false };
    }
    logger.step(`观察：净压力 ${netTokens} tokens（${formula}）≥ 阈值 ${threshold}，触发压缩`);
    const lastMessageIndex = indexCompleteMessages(session).length - 1;
    if (lastMessageIndex < 0) {
      logger.step('观察：会话尚无完整消息，跳过');
      return { failed: false };
    }
    triggerMessageIndex = lastMessageIndex;
    try {
      pendingSeq = appendObservePending(session, triggerMessageIndex);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`观察：待定标记追加失败，本轮跳过（下轮重新评估）: ${message}`);
      return { failed: false };
    }
    logger.step(
      `观察：记录待定标记（触发点完整消息 index ${triggerMessageIndex}），开始后台预压缩，等待 ${waitCount} 条新完整消息后注入`,
    );
  } else {
    triggerMessageIndex = pending.triggerMessageIndex;
    pendingSeq = pending.seq;
  }

  /** 注入成功后失效待定标记并清理注册表（done 任务的 abort 无副作用）。 */
  const clearPending = (): void => {
    try {
      appendObserveInvalidate(session, pendingSeq);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`观察：待定失效标记追加失败: ${message}`);
    }
    disposePrecompression(session.id);
  };

  // 阶段二：对账——活跃标记须对应持久化结果或后台任务，皆无（或任务失败）则启动
  const persisted = findPersistedSummary(session, pendingSeq);
  let adopted: AdoptedSummary | undefined;
  let job = findPrecompressionJob(session, pendingSeq);
  if (persisted !== undefined) {
    // 持久化结果优先（重启恢复不重压缩）；丢弃仍在运行的重复任务
    adopted = adoptPersistedSummary(persisted.data);
    if (job !== undefined && job.state === 'running') disposePrecompression(session.id);
    job = undefined;
    logger.step(`观察：采纳持久化压缩结果（om/observe-summary seq ${persisted.seq}）`);
  } else if (job === undefined || job.state === 'failed') {
    if (job !== undefined) {
      logger.step(`观察：后台任务失败（${job.failure?.error ?? '未知错误'}），丢弃并重启`);
      disposePrecompression(session.id);
    }
    const started = startPrecompression({
      ctx,
      session,
      config,
      target,
      pendingSeq,
      triggerMessageIndex,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    });
    if (!started.ok) {
      // 无可行区间：启动路径已失效待定标记，视为完成
      return { failed: false };
    }
    job = started.job;
  }

  // 阶段三：到期处理——新增完整消息数 ≥ tailMessageCount 时注入，未到期放行
  const arrived = indexCompleteMessages(session).length - 1 - triggerMessageIndex;
  if (arrived < waitCount) {
    logger.step(
      `观察：待定标记等待中（触发点完整消息 index ${triggerMessageIndex}，新增 ${arrived}/${waitCount}），后台${adopted !== undefined ? '已有持久化结果待注入' : `任务${job?.state ?? '未知'}`}`,
    );
    return { failed: false };
  }
  logger.step(
    `观察：待定标记延迟到期（触发点完整消息 index ${triggerMessageIndex}，新增 ${arrived} ≥ ${waitCount}），执行注入`,
  );
  let summaryResult: CompressionSuccess | undefined;
  let prepared: ObservePrepared | undefined;
  let commitTarget: RoutedTarget = target;
  let commitEffort: ReasoningEffortId | undefined = reasoningEffort;
  if (adopted !== undefined) {
    summaryResult = adopted.result;
    commitTarget = { provider: adopted.provider, model: adopted.model };
    commitEffort = adopted.reasoningEffort;
    // 采纳路径无内存任务：按当前表层重建区间（标记活跃即边界未后移，与压缩时一致）
    const prepare = prepareObserveCompression(session, triggerMessageIndex, config);
    if (!prepare.ok) {
      logger.step(`观察：${prepare.reason}，清除待定标记视为完成`);
      clearPending();
      return { failed: false };
    }
    prepared = prepare.prepared;
  } else if (job !== undefined) {
    if (job.state === 'running') {
      if (signal?.aborted) {
        logger.step('观察：pre-step 已中止，放行不注入（后台任务继续）');
        return { failed: false };
      }
      logger.step('观察：到期未完成预压缩，阻塞等待后台任务');
      await Promise.race([job.promise, signalAbortedRace(signal)]);
    }
    if (job.state === 'failed') {
      // 压缩失败不清除待定标记：下个 pre-step 对账时丢弃并重启任务重试
      const failure = job.failure;
      return {
        failed: true,
        error: failure?.error ?? '后台预压缩失败',
        aborted: failure?.aborted ?? false,
        ...(failure?.diagnosticSessionId === undefined
          ? {}
          : { diagnosticSessionId: failure.diagnosticSessionId }),
      };
    }
    if (job.state === 'running') {
      // race 由 signal 中止解决：放行不注入，任务继续后台，下个 pre-step 再对账
      logger.step('观察：等待期间 turn 被取消，放行不注入（后台任务继续）');
      return { failed: false };
    }
    summaryResult = job.result;
    prepared = job.prepared;
  }
  if (summaryResult === undefined || prepared === undefined) {
    logger.warn('观察：到期但无可注入的压缩结果，本轮跳过（下轮对账重试）');
    return { failed: false };
  }
  const triggerNote = `触发点完整消息 index ${triggerMessageIndex}`;
  logger.step(
    `观察：压缩区间 [${prepared.range.start}..${prepared.range.end}]，遮蔽 ${prepared.replaceSeqs.length} 个表层节点，压缩至${triggerNote}`,
  );
  const lifecycle: CompactionLifecycle = {
    compactionId: newCompactionId(),
    turn: openTurnOf(session),
  };
  try {
    logger.step('观察：追加 compaction/start（注入开始）');
    appendCompactionStart(session, lifecycle, 'observe');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`观察压缩启动失败: ${message}`);
    return { failed: false };
  }
  return commitObserveCompression(ctx, session, lifecycle, prepared, summaryResult, {
    target: commitTarget,
    maxTokens: config.compressMaxTokens,
    reasoningEffort: commitEffort,
    triggerNote,
    logger,
    clearPending,
  });
}

/**
 * 压力检查 + 两级压缩入口（pre-step 调用，仅主会话生效）：
 * 先反思（异步：只启动或提交后台任务，不阻塞、不失败），后观察（阻塞注入）。
 * 观察失败传播失败结果，由 pre-step 拒绝本 step 中断当前 turn。
 */
export async function maybeCompress(
  ctx: Context,
  agent: Agent,
  config: Readonly<PluginConfig>,
  signal?: AbortSignal,
): Promise<CompressPassResult> {
  const session = agent.session;
  const logger = makeLogger(ctx, config.debug);
  const target = compressionTarget(config, session);
  if (target === undefined) {
    logger.step('会话未路由（无 provider/model）且未配置压缩目标覆盖，跳过压缩');
    return { failed: false };
  }
  logger.step(`压缩路由：provider ${target.provider}，model ${target.model}`);
  const reasoningEffort = await resolveCompressionEffort(ctx, session, config, target, logger);
  const waitCount = config.tailMessageCount;
  logger.step('反思 pass 开始');
  reflectPass(ctx, agent, config, target, reasoningEffort);
  logger.step('反思 pass 结束，观察 pass 开始');
  const observe = await observePass(ctx, agent, config, waitCount, target, signal, reasoningEffort);
  logger.step('观察 pass 结束，压缩流程完成');
  return observe;
}
