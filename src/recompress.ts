/**
 * 换模型重压缩：对已成功的 compaction 用另一模型在临时循环里重新压缩一次，便于对比
 * 不同模型的压缩效果。导出 parseRecompressInput / recompress / RecompressRequest /
 * RecompressResult / buildRecompressCommand / RECOMPRESS_COMMAND_NAME。
 *
 * - 视图重放：compaction/summary 载荷的 shadowedSeqs 加 compaction/start 的 phase 足以
 *   重建当时的压缩视图（观察取被遮蔽的原消息，反思取被合并的 <history> 块），二者都只
 *   读日志，与当前表层无关
 * - 不改会话：不写 compaction/* 事件、不替换表层、不动观察待定标记；唯一副作用是压缩
 *   会话记录子会话及其在父会话的 subagent/catalog，标题带「重压缩 provider/model」
 * - 目标模型与思考等级由调用方显式指定，不做模型信息校验，也不受 compressProvider /
 *   compressModel 配置影响
 * - 仅主会话可用；同一会话同时仅允许一次重压缩
 * - 命令 /om-recompress 是压缩卡片按钮到服务端的内部通道（宿主命令通道），结果文本
 *   由发起方 UI 渲染，命令事件 log-only 不进模型上下文
 */

import type { CommandDefinition } from '@deepseek-ai/dsh-commands';

import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { historyTextOf } from './compress.ts';
import {
  buildCompressionTaskText,
  type CompressionLoopOptions,
  runCompressionLoop,
  viewCharCount,
} from './compress-loop.ts';
import { buildObserveView, buildReflectView, type CompressionView } from './compress-view.ts';
import { COMPACTION_ABORTED_ERROR } from './constants.ts';
import { formatCompactCount } from './format.ts';
import { makeLogger } from './logger.ts';
import type {
  Agent,
  CompactionEndPayload,
  CompactionStartPayload,
  CompactionSummaryPayload,
  Context,
  PluginConfig,
  Session,
} from './types.ts';
import { isMainSession, seqsCharCount } from './utils.ts';

/** 重压缩请求：被重放的 compaction 与目标模型。 */
export type RecompressRequest = {
  compactionId: string;
  provider: string;
  model: string;
  /** 目标模型思考等级 id；缺省用模型默认。 */
  reasoningEffort?: string;
};

/** 重压缩结果：成功携带新摘要与对比数据，失败携带错误与诊断子会话 id。 */
export type RecompressResult =
  | {
      ok: true;
      /** 新的 <history> 块文本。 */
      text: string;
      /** 被重放压缩的阶段。 */
      phase: 'observe' | 'reflect';
      /** 模型请求轮数。 */
      rounds: number;
      /** 原始消息字符数（被压缩视图的文本、工具参数与结果之和）。 */
      originalChars: number;
      /** 新摘要字符数。 */
      newChars: number;
      /** 循环总耗时（毫秒）。 */
      durationMs: number;
      /** 会话记录子会话 id（落盘失败时缺失）。 */
      recordSessionId?: string;
    }
  | { ok: false; error: string; recordSessionId?: string };

/** 命令行用法提示。 */
const USAGE = '用法：/om-recompress <compactionId> <provider> <model> [思考等级]';

/** 解析命令行：compactionId provider model [reasoningEffort]，空白分隔。 */
export function parseRecompressInput(
  rawInput: string,
): { ok: true; request: RecompressRequest } | { ok: false; error: string } {
  const parts = rawInput
    .trim()
    .split(/\s+/)
    .filter((part) => part !== '');
  const [compactionId, provider, model, reasoningEffort] = parts;
  if (
    compactionId === undefined ||
    provider === undefined ||
    model === undefined ||
    parts.length > 4
  ) {
    return { ok: false, error: USAGE };
  }
  return {
    ok: true,
    request: {
      compactionId,
      provider,
      model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    },
  };
}

/** 正在重压缩的会话 id（同一会话同时仅一次）。 */
const running = new Set<string>();

/** 日志中某 compaction 的生命周期事件。 */
type Lifecycle = {
  phase: CompactionStartPayload['phase'] | undefined;
  summary: CompactionSummaryPayload | undefined;
  end: CompactionEndPayload | undefined;
};

/** 按 compactionId 收集 start/summary/end 载荷。 */
function findLifecycle(session: Session, compactionId: string): Lifecycle {
  const lifecycle: Lifecycle = { phase: undefined, summary: undefined, end: undefined };
  for (const event of session.snapshotEvents()) {
    if (event.type === 'compaction/start') {
      const data = event.data as CompactionStartPayload;
      if (String(data.compactionId) === compactionId) lifecycle.phase = data.phase;
    } else if (event.type === 'compaction/summary') {
      const data = event.data as CompactionSummaryPayload;
      if (String(data.compactionId) === compactionId) lifecycle.summary = data;
    } else if (event.type === 'compaction/end') {
      const data = event.data as CompactionEndPayload;
      if (String(data.compactionId) === compactionId) lifecycle.end = data;
    }
  }
  return lifecycle;
}

/** 重建被压缩内容的视图；不可重建时返回错误。 */
function rebuildView(
  session: Session,
  phase: 'observe' | 'reflect',
  shadowedSeqs: number[],
  skipReasoning: boolean,
): CompressionView | string {
  if (phase === 'reflect') {
    const blocks = shadowedSeqs.flatMap((seq) => {
      const text = historyTextOf(session.snapshotEvents()[seq]);
      return text === undefined ? [] : [{ text, seq }];
    });
    return buildReflectView(blocks, { skipReasoning });
  }
  return buildObserveView(session, shadowedSeqs, { skipReasoning });
}

/**
 * 对已成功的 compaction 用目标模型重压缩一次。校验失败、压缩循环失败均以
 * { ok: false } 返回，不抛错；会话本身不被修改（见文件头说明）。
 */
export async function recompress(
  ctx: Context,
  agent: Agent,
  config: Readonly<PluginConfig>,
  request: RecompressRequest,
  signal?: AbortSignal,
): Promise<RecompressResult> {
  const session = agent.session;
  if (!isMainSession(session)) return { ok: false, error: '重压缩仅支持主会话' };
  const lifecycle = findLifecycle(session, request.compactionId);
  if (lifecycle.phase === undefined && lifecycle.summary === undefined) {
    return { ok: false, error: `未找到压缩 ${request.compactionId}` };
  }
  const summary = lifecycle.summary;
  if (summary === undefined || lifecycle.end === undefined || lifecycle.end.error !== undefined) {
    return { ok: false, error: `压缩 ${request.compactionId} 未成功完成，无法重压缩` };
  }
  const shadowedSeqs = (summary.shadowedSeqs ?? []).map(Number);
  if (shadowedSeqs.length === 0) {
    return { ok: false, error: `压缩 ${request.compactionId} 缺少 shadowedSeqs，无法重放` };
  }
  const firstEvent = session.snapshotEvents()[shadowedSeqs[0] ?? -1];
  const phase =
    lifecycle.phase ?? (historyTextOf(firstEvent) === undefined ? 'observe' : 'reflect');
  const view = rebuildView(session, phase, shadowedSeqs, config.compressSkipReasoning);
  if (typeof view === 'string') return { ok: false, error: view };
  if (view.minIndex === undefined || view.maxIndex === undefined) {
    return { ok: false, error: `压缩 ${request.compactionId} 的原内容无可定位条目` };
  }
  if (signal?.aborted === true) return { ok: false, error: COMPACTION_ABORTED_ERROR };
  if (running.has(session.id)) return { ok: false, error: '该会话已有重压缩进行中' };

  const target = { provider: request.provider, model: request.model };
  const logger = makeLogger(ctx, config.debug);
  running.add(session.id);
  try {
    logger.step(
      `重压缩：${request.compactionId}（${phase}）→ ${target.provider}/${target.model}${
        request.reasoningEffort === undefined ? '' : ` · ${request.reasoningEffort}`
      }`,
    );
    const originalChars =
      summary.shadowedCharCount ??
      (phase === 'observe' ? seqsCharCount(session, shadowedSeqs) : viewCharCount(view));
    const outcome = await runCompressionLoop(ctx, session, {
      view,
      originalChars,
      phase,
      taskText: buildCompressionTaskText(phase, view.minIndex, view.maxIndex),
      target,
      maxTokens: config.compressMaxTokens,
      rateLimitWaitMs: config.rateLimitWaitMs,
      skipReasoning: config.compressSkipReasoning,
      debug: config.debug,
      retryTarget: target,
      ...(request.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: request.reasoningEffort as ReasoningEffortId }),
      ...(signal === undefined ? {} : { signal }),
    } satisfies CompressionLoopOptions);
    if (!outcome.ok) {
      return {
        ok: false,
        error: outcome.error,
        ...(outcome.recordSessionId === undefined
          ? {}
          : { recordSessionId: outcome.recordSessionId }),
      };
    }
    return {
      ok: true,
      text: outcome.text,
      phase,
      rounds: outcome.rounds,
      originalChars,
      newChars: outcome.text.length,
      durationMs: outcome.stats.durationMs,
      ...(outcome.recordSessionId === undefined
        ? {}
        : { recordSessionId: outcome.recordSessionId }),
    };
  } finally {
    running.delete(session.id);
  }
}

/** 重压缩命令名（压缩卡片按钮经宿主命令通道调用）。 */
export const RECOMPRESS_COMMAND_NAME = 'om-recompress';

/** 毫秒耗时的简短文本。 */
function secondsText(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

/** 渲染命令结果文本：成功为「模型(等级)，原始消息 → 产物，耗时」，失败给出原因。 */
function describeResult(request: RecompressRequest, result: RecompressResult): string {
  const label = `${request.provider}/${request.model}(${request.reasoningEffort ?? '默认'})`;
  if (!result.ok) return `重压缩失败 ${label}：${result.error}`;
  return `重压缩完成 ${label}，${formatCompactCount(result.originalChars)} → ${formatCompactCount(result.newChars)}，${secondsText(result.durationMs)}`;
}

/** 构造 /om-recompress 命令定义；配置按调用时刻读取。 */
export function buildRecompressCommand(
  ctx: Context,
  getConfig: () => Readonly<PluginConfig>,
): CommandDefinition {
  return {
    name: RECOMPRESS_COMMAND_NAME,
    description: '由压缩卡片调用：用另一模型重新压缩一次已完成的压缩',
    input: { hint: '<compactionId> <provider> <model> [思考等级]' },
    handler: async ({ agent, rawInput, signal }) => {
      const parsed = parseRecompressInput(rawInput);
      if (!parsed.ok) return { kind: 'error', text: parsed.error };
      const result = await recompress(ctx, agent, getConfig(), parsed.request, signal);
      const text = describeResult(parsed.request, result);
      return result.ok ? { kind: 'success', text } : { kind: 'error', text };
    },
  };
}
