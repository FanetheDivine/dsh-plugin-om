/**
 * 后台预压缩任务：进程内注册表与任务主体。
 * 导出 startPrecompression / findPrecompressionJob / adoptPersistedSummary /
 * disposePrecompression / disposeAllPrecompressions 与类型 PrecompressJob / AdoptedSummary。
 *
 * - 观察待定标记写入后立即启动：prepareObserveCompression 同步计算区间与视图
 *   （无可行区间时失效待定标记、不启动任务），压缩循环在后台以自有 AbortController 运行
 * - 任务成功只写 om/observe-summary 信封持久化压缩结果并 flush，不做表层替换；
 *   注入（compaction 生命周期 + <history> 替换）由到期 pre-step 在同一开放 turn 内完成
 * - 重启恢复：日志中匹配 pendingSeq 的 om/observe-summary 经 adoptPersistedSummary
 *   合成压缩成功结果直接采纳，不重压缩；无结果信封时按对账逻辑重新启动任务
 * - 总体上限 observeJobMaxMs：传输失败或流挂起时到点中止任务自有控制器，
 *   压缩循环按 aborted 失败结算 job.promise，等待方不再无限阻塞；pre-step 的等待
 *   上限 observeWaitMaxMs 与本上限无关，到点只是本轮放行，任务照常继续
 * - 注册表按 session.id 键控；会话对象或待定标记不一致视为过期（中止并移除）；
 *   session/disposed 与插件卸载经 disposeSessionPrecompressionState /
 *   disposeAllPrecompressions 清理，失败记录与失效冷却一并清除；已销毁的会话对象记入
 *   WeakSet，任务结算时据此跳过失败记录写入（无归属的失败记录只会成为孤儿）
 * - 失效冷却：待定标记失效后按会话记录冷却截止时间（observeInvalidateCooldownMs），
 *   冷却期内不再为该会话重新打标；冷却状态按会话隔离，会话销毁或插件卸载时清理
 */
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { type ObservePrepared, prepareObserveCompression } from './compress.ts';
import {
  buildCompressionTaskText,
  type CompressionLoopOptions,
  type CompressionSuccess,
  runCompressionLoop,
} from './compress-loop.ts';
import type { PluginLogger } from './logger.ts';
import { makeLogger } from './logger.ts';
import type { OmEventPayloadMap } from './om-event.ts';
import { appendOmEvent } from './om-event-append.ts';
import type { Context, PluginConfig, Session } from './types.ts';
import type { RoutedTarget } from './utils.ts';

/** 任务状态：运行中 / 成功（结果已持久化）/ 失败。 */
export type PrecompressJobState = 'running' | 'done' | 'failed';

/** 任务失败详情（error 为最后一次错误；aborted 为因 signal 中止）。 */
export type PrecompressFailure = {
  error: string;
  aborted: boolean;
  /** 压缩会话记录（诊断）子会话 id（落盘失败时缺失）。 */
  diagnosticSessionId?: string;
};

/** 一个后台预压缩任务（注册表条目）。 */
export type PrecompressJob = {
  /** 所属 om/observe-pending 事件 seq（与活跃标记匹配方可使用）。 */
  readonly pendingSeq: number;
  /** 触发点完整消息 index（区间/视图按此冻结）。 */
  readonly triggerMessageIndex: number;
  /** 启动时的会话对象（身份校验用；重载后对象不同即过期）。 */
  readonly session: Session;
  /** 启动时同步准备的区间与视图。 */
  readonly prepared: ObservePrepared;
  /** 任务自有取消控制器（与会话 turn 的 signal 解耦）。 */
  readonly controller: AbortController;
  /** 任务到达终态（done/failed）时 resolve；不 reject。 */
  readonly promise: Promise<void>;
  state: PrecompressJobState;
  /** state='done' 时的压缩成功结果。 */
  result?: CompressionSuccess;
  /** state='failed' 时的失败详情。 */
  failure?: PrecompressFailure;
};

/** 启动选项。 */
export type PrecompressStartOptions = {
  ctx: Context;
  session: Session;
  config: Readonly<PluginConfig>;
  /** 压缩路由目标（覆盖配置或会话路由，调用方已解析）。 */
  target: RoutedTarget;
  /** 活跃 om/observe-pending 事件 seq。 */
  pendingSeq: number;
  /** 触发点完整消息 index（= 待定标记记录值）。 */
  triggerMessageIndex: number;
  /** 已校验的思考等级；undefined 用模型默认。 */
  reasoningEffort?: ReasoningEffortId;
};

/** 启动结果：ok=false 时无可行区间（待定标记已失效，调用方按完成处理）。 */
export type PrecompressStartResult =
  | { ok: true; job: PrecompressJob }
  | { ok: false; reason: string };

/** 采纳的持久化压缩结果（provider/model/reasoningEffort 为压缩实际使用值）。 */
export type AdoptedSummary = {
  result: CompressionSuccess;
  provider: string;
  model: string;
  reasoningEffort?: ReasoningEffortId;
};

/** 进程内注册表：session.id → 任务（重启即清空，由对账阶段恢复）。 */
const jobs = new Map<string, PrecompressJob>();

/** 连续失败退避倍率：第 n 次连续失败后等待 base × 倍率才允许重启，超出取末位封顶。 */
const FAILURE_BACKOFF_FACTOR = [1, 5, 15] as const;

/** 一个待定标记的连续失败状态。 */
type FailureState = {
  /** 所属 om/observe-pending 事件 seq。 */
  pendingSeq: number;
  /** 连续失败次数。 */
  count: number;
  /** 下次允许重启任务的时间戳（毫秒）。 */
  retryAt: number;
};

/** 进程内失败状态：session.id → 连续失败记录（成功、失效或换标记即清除）。 */
const failures = new Map<string, FailureState>();

/** 失效冷却：session.id → 冷却截止时间戳（毫秒；无记录表示不在冷却期）。 */
const invalidateCooldowns = new Map<string, number>();

/** 已销毁的会话对象（WeakSet：对象被回收即消失，不积累内存）。 */
const disposedSessions = new WeakSet<Session>();

/** 记录一次待定标记失效：该会话在 cooldownMs 内不再重新打标（0 表示不冷却）。 */
export function noteObserveInvalidate(
  sessionId: string,
  cooldownMs: number,
  now = Date.now(),
): void {
  if (cooldownMs <= 0) {
    invalidateCooldowns.delete(sessionId);
    return;
  }
  invalidateCooldowns.set(sessionId, now + cooldownMs);
}

/** 剩余失效冷却毫秒数（不在冷却期返回 0，到期记录随之清除）。 */
export function observeInvalidateCooldown(sessionId: string, now = Date.now()): number {
  const until = invalidateCooldowns.get(sessionId);
  if (until === undefined) return 0;
  const remaining = until - now;
  if (remaining > 0) return remaining;
  invalidateCooldowns.delete(sessionId);
  return 0;
}

/** 会话对象是否仍存活（被 session/disposed 标记过的对象视为已销毁）。 */
export function isSessionLive(session: Session): boolean {
  return !disposedSessions.has(session);
}

/** 清除会话的失败记录；pendingSeq 给定时仅当记录属于该标记才清除。 */
export function clearPrecompressionFailure(sessionId: string, pendingSeq?: number): void {
  const state = failures.get(sessionId);
  if (state === undefined) return;
  if (pendingSeq !== undefined && state.pendingSeq !== pendingSeq) return;
  failures.delete(sessionId);
}

/**
 * 记录一次任务失败并推进退避：返回该标记的连续失败次数。
 * 退避期内对账阶段直接放行，不再立刻重启任务。
 */
export function notePrecompressionFailure(
  sessionId: string,
  pendingSeq: number,
  backoffMs: number,
  now = Date.now(),
): number {
  const previous = failures.get(sessionId);
  const count =
    previous !== undefined && previous.pendingSeq === pendingSeq ? previous.count + 1 : 1;
  const factor = FAILURE_BACKOFF_FACTOR[Math.min(count, FAILURE_BACKOFF_FACTOR.length) - 1] ?? 0;
  const wait = backoffMs > 0 ? backoffMs * factor : 0;
  failures.set(sessionId, { pendingSeq, count, retryAt: now + wait });
  return count;
}

/**
 * 读取待定标记的失败状态（只读）：连续失败次数与距允许重启的剩余毫秒数。
 * 计数只由任务结算（notePrecompressionFailure）推进，对账阶段不得重复累加。
 */
export function precompressionFailureState(
  sessionId: string,
  pendingSeq: number,
  now = Date.now(),
): { count: number; waitMs: number } {
  const state = failures.get(sessionId);
  if (state === undefined || state.pendingSeq !== pendingSeq) return { count: 0, waitMs: 0 };
  return { count: state.count, waitMs: Math.max(0, state.retryAt - now) };
}

/** 查询会话当前任务（不校验身份；对账用 findPrecompressionJob）。 */
export function peekPrecompressionJob(sessionId: string): PrecompressJob | undefined {
  return jobs.get(sessionId);
}

/**
 * 查询与活跃待定标记匹配的任务：pendingSeq 或会话对象不一致视为过期，
 * 中止并移除后返回 undefined（过期任务的信封写入落在已脱钩对象上，无保留价值）。
 */
export function findPrecompressionJob(
  session: Session,
  pendingSeq: number,
): PrecompressJob | undefined {
  const job = jobs.get(session.id);
  if (job === undefined) return undefined;
  if (job.session === session && job.pendingSeq === pendingSeq) return job;
  disposePrecompression(session.id);
  return undefined;
}

/**
 * 启动后台预压缩：同步准备区间/视图；无可行区间时失效待定标记并返回原因。
 * 同会话已有匹配任务时幂等返回；标记不同则中止旧任务后替换。
 */
export function startPrecompression(options: PrecompressStartOptions): PrecompressStartResult {
  const { ctx, session, config, pendingSeq, triggerMessageIndex } = options;
  const logger = makeLogger(ctx, config.debug);
  const existing = jobs.get(session.id);
  if (existing !== undefined) {
    if (existing.session === session && existing.pendingSeq === pendingSeq) {
      return { ok: true, job: existing };
    }
    // 标记已更换：旧标记的失败记录不再适用
    disposePrecompressionWithFailureState(session.id);
  }
  const prepare = prepareObserveCompression(session, triggerMessageIndex, config);
  if (!prepare.ok) {
    logger.step(`预压缩：${prepare.reason}，失效待定标记视为完成`);
    try {
      appendOmEvent(session, 'om/observe-invalidate', { pendingSeq });
      noteObserveInvalidate(session.id, config.observeInvalidateCooldownMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`预压缩：待定失效标记追加失败: ${message}`);
    }
    return { ok: false, reason: prepare.reason };
  }
  const controller = new AbortController();
  let settle!: () => void;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const job: PrecompressJob = {
    pendingSeq,
    triggerMessageIndex,
    session,
    prepared: prepare.prepared,
    controller,
    promise,
    state: 'running',
  };
  jobs.set(session.id, job);
  void runJobBody(ctx, job, options, logger).then(settle, settle);
  const guard = startJobTimeout(job, config.observeJobMaxMs, logger);
  const done = (): void => {
    clearJobTimeout(guard)();
    if (job.state === 'done') {
      clearPrecompressionFailure(session.id, pendingSeq);
      return;
    }
    if (job.state !== 'failed') return;
    if (!isSessionLive(session)) {
      logger.step(`预压缩：会话 ${session.id} 已销毁，跳过失败记录（pendingSeq ${pendingSeq}）`);
      return;
    }
    notePrecompressionFailure(session.id, pendingSeq, options.config.observeRetryBackoffMs);
  };
  void promise.then(done, done);
  logger.step(
    `预压缩：任务启动（pendingSeq ${pendingSeq}，区间 [${prepare.prepared.range.start}..${prepare.prepared.range.end}]，遮蔽 ${prepare.prepared.replaceSeqs.length} 个表层节点）`,
  );
  return { ok: true, job };
}

/**
 * 任务总体上限：传输挂起（流永不结束）时到点中止任务自有控制器，
 * 压缩循环据此以 aborted 失败结算 job.promise，底层流随 signal 释放。
 * 上限须大于一次正常压缩的耗时（大上下文压缩可能持续数分钟）；配置为 0 返回 undefined（不设上限）。
 */
function startJobTimeout(
  job: PrecompressJob,
  maxMs: number,
  logger: PluginLogger,
): ReturnType<typeof setTimeout> | undefined {
  if (maxMs <= 0) return undefined;
  return setTimeout(() => {
    if (job.state !== 'running') return;
    logger.warn(`预压缩超时（pendingSeq ${job.pendingSeq}，超过 ${maxMs}ms），中止任务`);
    job.controller.abort();
  }, maxMs);
}

/** 任务结算后清理上限计时器（已触发或未启动时无操作）。 */
function clearJobTimeout(timer: ReturnType<typeof setTimeout> | undefined): () => void {
  return () => {
    if (timer !== undefined) clearTimeout(timer);
  };
}

/** 任务主体：压缩循环 → 成功持久化结果信封 + flush → 状态登记；异常按失败处理。 */
async function runJobBody(
  ctx: Context,
  job: PrecompressJob,
  options: PrecompressStartOptions,
  logger: PluginLogger,
): Promise<void> {
  const { config, target, reasoningEffort } = options;
  const { prepared } = job;
  try {
    const outcome = await runCompressionLoop(ctx, job.session, {
      view: prepared.view,
      originalChars: prepared.shadowedCharCount,
      phase: 'observe',
      taskText: buildCompressionTaskText('observe', prepared.view.minIndex, prepared.view.maxIndex),
      target,
      maxTokens: config.compressMaxTokens,
      rateLimitWaitMs: config.rateLimitWaitMs,
      jobMaxMs: config.observeJobMaxMs,
      skipReasoning: config.compressSkipReasoning,
      debug: config.debug,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      signal: job.controller.signal,
    } satisfies CompressionLoopOptions);
    if (!outcome.ok) {
      job.state = 'failed';
      job.failure = {
        error: outcome.error,
        aborted: outcome.aborted,
        ...(outcome.recordSessionId === undefined
          ? {}
          : { diagnosticSessionId: outcome.recordSessionId }),
      };
      logger.info(`预压缩失败（pendingSeq ${job.pendingSeq}）: ${outcome.error}`);
      return;
    }
    // 结果信封持久化：注入前崩溃时重启后按 pendingSeq 匹配采纳，不重压缩；
    // 不做表层替换（注入由到期 pre-step 在同一开放 turn 内完成）
    appendOmEvent(job.session, 'om/observe-summary', {
      pendingSeq: job.pendingSeq,
      report: outcome.text,
      provider: target.provider,
      model: target.model,
      startedAt: outcome.stats.startedAt,
      completedAt: outcome.stats.completedAt,
      durationMs: outcome.stats.durationMs,
      ...(outcome.recordSessionId === undefined
        ? {}
        : { recordSessionId: outcome.recordSessionId }),
      ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    });
    await flushSession(ctx, job.session, logger);
    job.state = 'done';
    job.result = outcome;
    logger.info(
      `预压缩完成（pendingSeq ${job.pendingSeq}，${outcome.stats.durationMs}ms），等待到期注入`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    job.state = 'failed';
    job.failure = { error: message, aborted: job.controller.signal.aborted };
    logger.warn(`预压缩任务异常（pendingSeq ${job.pendingSeq}）: ${message}`);
  }
}

/** 结果信封落盘：sessions.flush 失败仅记日志（内存日志仍在，turn 结束时宿主兜底 flush）。 */
async function flushSession(ctx: Context, session: Session, logger: PluginLogger): Promise<void> {
  try {
    const sessions = ctx.get('sessions');
    if (sessions === undefined) {
      logger.warn('预压缩：sessions 服务未挂载，结果信封跳过即时 flush');
      return;
    }
    await sessions.flush(session);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`预压缩：结果信封 flush 失败: ${message}`);
  }
}

/**
 * 采纳持久化的 om/observe-summary 信封为压缩成功结果（重启恢复路径）。
 * 轮数信息未持久化：rounds 按 0 与空数组重建（仅诊断记录使用，注入不依赖）。
 */
export function adoptPersistedSummary(
  data: OmEventPayloadMap['om/observe-summary'],
): AdoptedSummary {
  return {
    result: {
      ok: true,
      text: data.report,
      rounds: 0,
      stats: {
        startedAt: data.startedAt,
        completedAt: data.completedAt,
        durationMs: data.durationMs,
        rounds: [],
      },
      ...(data.usage === undefined ? {} : { usage: data.usage }),
      ...(data.recordSessionId === undefined ? {} : { recordSessionId: data.recordSessionId }),
    },
    provider: data.provider,
    model: data.model,
    // 信封写入前已经过 resolveCompressionEffort 校验（品牌由写入路径担保）
    ...(data.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: data.reasoningEffort as ReasoningEffortId }),
  };
}

/** 中止并移除会话的后台任务（session/disposed 或过期清理）。 */
export function disposePrecompression(sessionId: string): void {
  const job = jobs.get(sessionId);
  if (job === undefined) return;
  jobs.delete(sessionId);
  job.controller.abort();
}

/** 中止并移除会话的后台任务，同时清除其失败记录（待定标记被失效时调用）。 */
export function disposePrecompressionWithFailureState(sessionId: string): void {
  disposePrecompression(sessionId);
  failures.delete(sessionId);
}

/**
 * 会话销毁清理：标记会话对象已销毁，中止任务并清除失败记录与失效冷却（session/disposed 调用）。
 * 待定标记与持久化结果仍在日志中，重启后由对账恢复。
 */
export function disposeSessionPrecompressionState(session: Session): void {
  disposedSessions.add(session);
  disposePrecompressionWithFailureState(session.id);
  invalidateCooldowns.delete(session.id);
}

/** 中止并移除全部后台任务（插件卸载），失败记录与失效冷却一并清空。 */
export function disposeAllPrecompressions(): void {
  for (const sessionId of [...jobs.keys()]) disposePrecompression(sessionId);
  failures.clear();
  invalidateCooldowns.clear();
}
