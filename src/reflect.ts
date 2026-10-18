/**
 * 异步反思：进程内任务注册表、任务主体与归档块选择。
 * 导出 startReflection / peekReflectJob / takeReflectJob / reflectFailedKey /
 * disposeReflection / disposeAllReflections / selectArchiveBlocks / historyBlocksKey
 * 与类型 ReflectJob / ReflectStartOptions。
 *
 * - 同一会话最多一个任务；任务以自有 AbortController 在后台运行压缩循环，不阻塞 pre-step
 * - 任务结果只存内存：提交由完成后的首个 pre-step 在开放 turn 内完成（compress.ts）
 * - 非中止失败记录当时的 history 块集合键；集合不变时不再重试
 * - session/disposed 与插件卸载经 disposeReflection / disposeAllReflections 中止任务
 */
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import {
  buildCompressionTaskText,
  type CompressionLoopOptions,
  type CompressionSuccess,
  runCompressionLoop,
} from './compress-loop.ts';
import type { ArchivedSkill, CompressionView } from './compress-view.ts';
import { makeLogger } from './logger.ts';
import type { Context, PluginConfig, Session } from './types.ts';
import type { RoutedTarget } from './utils.ts';

/** 压缩块：块文本与表层 seq。 */
export type HistoryBlock = { text: string; seq: number };

/** 任务状态：运行中 / 成功（结果待提交）/ 失败。 */
export type ReflectJobState = 'running' | 'done' | 'failed';

/** 一个后台反思任务（注册表条目）。 */
export type ReflectJob = {
  /** 启动时的会话对象（重载后对象不同即过期）。 */
  readonly session: Session;
  /** 触发时全部 history 块的集合键（失败后据此判断是否重试）。 */
  readonly key: string;
  /** 被归档的 history 块（表层顺序）。 */
  readonly archived: readonly HistoryBlock[];
  /** 归档视图。 */
  readonly view: CompressionView;
  /** 从被归档块提取的 skill（同名保留最新）。 */
  readonly skills: readonly ArchivedSkill[];
  /** 被归档块的估算 token（字符/4，影子价格单位）。 */
  readonly estimatedTokens: number;
  /** 被归档块的内文字符数。 */
  readonly shadowedCharCount: number;
  readonly target: RoutedTarget;
  readonly reasoningEffort?: ReasoningEffortId;
  readonly controller: AbortController;
  /** 任务到达终态时 resolve；不 reject。 */
  readonly promise: Promise<void>;
  state: ReflectJobState;
  result?: CompressionSuccess;
  failure?: { error: string; aborted: boolean; diagnosticSessionId?: string };
};

/** 启动选项。 */
export type ReflectStartOptions = {
  ctx: Context;
  session: Session;
  config: Readonly<PluginConfig>;
  target: RoutedTarget;
  reasoningEffort?: ReasoningEffortId;
  key: string;
  archived: readonly HistoryBlock[];
  view: CompressionView;
  skills: readonly ArchivedSkill[];
  estimatedTokens: number;
  shadowedCharCount: number;
};

/** session.id → 任务。 */
const jobs = new Map<string, ReflectJob>();
/** session.id → 最近一次非中止失败时的 history 块集合键。 */
const failedKeys = new Map<string, string>();

/** history 块集合键：按 seq 拼接。 */
export function historyBlocksKey(blocks: readonly HistoryBlock[]): string {
  return blocks.map((block) => block.seq).join(',');
}

/**
 * 选择归档块：从最后一个块往前累加 token，合计不超过 keepBudget 的尾部块保留，
 * 至少保留 1 个；其余全部归档。tokensOf 返回单块 token。
 */
export function selectArchiveBlocks<T>(
  blocks: readonly T[],
  tokensOf: (block: T) => number,
  keepBudget: number,
): { archived: T[]; kept: T[] } {
  let keepFrom = blocks.length;
  let total = 0;
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i] as T;
    const next = total + tokensOf(block);
    if (keepFrom < blocks.length && next > keepBudget) break;
    total = next;
    keepFrom = i;
  }
  return { archived: blocks.slice(0, keepFrom), kept: blocks.slice(keepFrom) };
}

/** 查询会话当前任务。 */
export function peekReflectJob(sessionId: string): ReflectJob | undefined {
  return jobs.get(sessionId);
}

/** 取出会话当前任务并从注册表移除（提交或丢弃前调用）。 */
export function takeReflectJob(sessionId: string): ReflectJob | undefined {
  const job = jobs.get(sessionId);
  jobs.delete(sessionId);
  return job;
}

/** 最近一次非中止失败时的 history 块集合键。 */
export function reflectFailedKey(sessionId: string): string | undefined {
  return failedKeys.get(sessionId);
}

/** 启动后台反思；调用方保证同会话无运行中任务。 */
export function startReflection(options: ReflectStartOptions): ReflectJob {
  const { ctx, session, config, target, reasoningEffort } = options;
  const logger = makeLogger(ctx, config.debug);
  const controller = new AbortController();
  let settle!: () => void;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const job: ReflectJob = {
    session,
    key: options.key,
    archived: options.archived,
    view: options.view,
    skills: options.skills,
    estimatedTokens: options.estimatedTokens,
    shadowedCharCount: options.shadowedCharCount,
    target,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    controller,
    promise,
    state: 'running',
  };
  jobs.set(session.id, job);
  failedKeys.delete(session.id);
  void runJobBody(ctx, job, config).then(settle, settle);
  return job;

  async function runJobBody(
    context: Context,
    current: ReflectJob,
    cfg: Readonly<PluginConfig>,
  ): Promise<void> {
    const { view } = current;
    try {
      const outcome = await runCompressionLoop(context, current.session, {
        view,
        originalChars: current.shadowedCharCount,
        phase: 'reflect',
        taskText: buildCompressionTaskText(
          'reflect',
          view.minIndex ?? 0,
          view.maxIndex ?? 0,
          view.segments,
        ),
        target: current.target,
        maxTokens: cfg.compressMaxTokens,
        rateLimitWaitMs: cfg.rateLimitWaitMs,
        skipReasoning: cfg.compressSkipReasoning,
        debug: cfg.debug,
        ...(current.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: current.reasoningEffort }),
        signal: current.controller.signal,
      } satisfies CompressionLoopOptions);
      if (outcome.ok) {
        current.state = 'done';
        current.result = outcome;
        logger.info(`反思完成（${outcome.stats.durationMs}ms），等待下一个 pre-step 提交`);
        return;
      }
      fail(current, {
        error: outcome.error,
        aborted: outcome.aborted,
        ...(outcome.recordSessionId === undefined
          ? {}
          : { diagnosticSessionId: outcome.recordSessionId }),
      });
      logger.info(`反思失败: ${outcome.error}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fail(current, { error: message, aborted: current.controller.signal.aborted });
      logger.warn(`反思任务异常: ${message}`);
    }
  }
}

/** 登记失败；非中止失败记录集合键，阻止同一块集合重试。 */
function fail(job: ReflectJob, failure: NonNullable<ReflectJob['failure']>): void {
  job.state = 'failed';
  job.failure = failure;
  if (!failure.aborted && jobs.get(job.session.id) === job) {
    failedKeys.set(job.session.id, job.key);
  }
}

/** 中止并移除会话的反思任务，清除失败记录。 */
export function disposeReflection(sessionId: string): void {
  failedKeys.delete(sessionId);
  const job = jobs.get(sessionId);
  if (job === undefined) return;
  jobs.delete(sessionId);
  job.controller.abort();
}

/** 中止并移除全部反思任务（插件卸载）。 */
export function disposeAllReflections(): void {
  for (const sessionId of [...jobs.keys()]) disposeReflection(sessionId);
  failedKeys.clear();
}
