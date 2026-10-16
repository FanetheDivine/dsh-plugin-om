// 后台预压缩任务单测：启动准备（无区间失效标记）、成功持久化结果信封与 flush、
// 失败登记、幂等与身份不匹配清理、持久化结果采纳、dispose 中止与全局清理。
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import { beforeEach, describe, expect, it } from 'vitest';
import { findObservePending } from '../src/compress.ts';
import { resolveConfig } from '../src/config.ts';
import { indexCompleteMessages } from '../src/log-index.ts';
import { appendOmEvent, findOmEvents } from '../src/om-event.ts';
import {
  adoptPersistedSummary,
  disposeAllPrecompressions,
  disposePrecompression,
  findPrecompressionJob,
  type PrecompressStartOptions,
  peekPrecompressionJob,
  startPrecompression,
} from '../src/precompress.ts';
import type { Context, Session } from '../src/types.ts';
import { buildToolCallFlow, makeCtx, makeSession, roundChunks, throwingStream } from './helpers.ts';

/** 成功完成压缩的工具轮工厂（getHistory → compressHistory → completeCompression）。 */
function successFactory() {
  return (index: number) => {
    if (index === 0) return roundChunks({ calls: [{ id: 'g1', name: 'getHistory' }] });
    if (index === 1)
      return roundChunks({
        calls: [
          {
            id: 't2',
            name: 'compressHistory',
            args: { start: 1, end: 2, content: 'toolcall index:2 purpose:任务A summary:完成' },
          },
        ],
      });
    return roundChunks({ calls: [{ id: 'c9', name: 'completeCompression' }] });
  };
}

/** 首轮挂起直到 signal 中止的流工厂（观察 running 状态与 dispose 中止）。 */
function hangingFactory() {
  return (_round: number, rawOptions: unknown) => {
    const options = rawOptions as GenerateOptions;
    return (async function* () {
      await new Promise<void>((resolve) => {
        const signal = options.signal;
        if (signal === undefined || signal.aborted) return resolve();
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      yield { type: 'finish', reason: { kind: 'aborted' } };
    })();
  };
}

/** 构造可压缩会话（完整工具调用流 + turn/end）并写入待定标记。 */
function fixtureSession(): { session: Session; pendingSeq: number; triggerMessageIndex: number } {
  const session = makeSession({
    events: buildToolCallFlow({
      code: 'a()',
      description: '任务A',
      callId: 'c1',
      resultText: 'r1',
      withTurnEnd: true,
    }),
  });
  const cms = indexCompleteMessages(session);
  const triggerMessageIndex = cms[cms.length - 1]?.index ?? 0;
  const pendingSeq = appendOmEvent(session, 'om/observe-pending', { triggerMessageIndex });
  return { session, pendingSeq, triggerMessageIndex };
}

/** 启动参数（target 默认测试路由；其余可覆盖）。 */
function startOptions(
  ctx: Context,
  session: Session,
  pendingSeq: number,
  triggerMessageIndex: number,
  overrides: Partial<PrecompressStartOptions> = {},
): PrecompressStartOptions {
  return {
    ctx,
    session,
    config: resolveConfig({}),
    target: { provider: 'test', model: 'test-model' },
    pendingSeq,
    triggerMessageIndex,
    ...overrides,
  };
}

beforeEach(() => {
  disposeAllPrecompressions();
});

describe('启动与准备', () => {
  it('无可行区间时失效待定标记且不启动任务', () => {
    const session = makeSession();
    const pendingSeq = appendOmEvent(session, 'om/observe-pending', { triggerMessageIndex: 0 });
    const ctx = makeCtx({ llmStreamFactory: successFactory() });
    const started = startPrecompression(startOptions(ctx, session, pendingSeq, 0));
    expect(started.ok).toBe(false);
    if (started.ok) throw new Error('unreachable');
    expect(started.reason).toContain('无可行压缩区间');
    const invalidates = findOmEvents(session, 'om/observe-invalidate');
    expect(invalidates).toHaveLength(1);
    expect(invalidates[0]?.data.pendingSeq).toBe(pendingSeq);
    expect(findObservePending(session)).toBeUndefined();
    expect(peekPrecompressionJob(session.id)).toBeUndefined();
    expect(ctx._llmCalls).toHaveLength(0);
  });

  it('有区间时启动任务：登记 running，dispose 中止后任务按 aborted 失败', async () => {
    const { session, pendingSeq, triggerMessageIndex } = fixtureSession();
    const ctx = makeCtx({ llmStreamFactory: hangingFactory() });
    const started = startPrecompression(
      startOptions(ctx, session, pendingSeq, triggerMessageIndex),
    );
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error('unreachable');
    expect(started.job.state).toBe('running');
    expect(findPrecompressionJob(session, pendingSeq)).toBe(started.job);
    disposePrecompression(session.id);
    expect(started.job.controller.signal.aborted).toBe(true);
    expect(peekPrecompressionJob(session.id)).toBeUndefined();
    await started.job.promise;
    expect(started.job.state).toBe('failed');
    expect(started.job.failure?.aborted).toBe(true);
  });

  it('同 pendingSeq 重复启动幂等返回原任务（不重复开流）', async () => {
    const { session, pendingSeq, triggerMessageIndex } = fixtureSession();
    const ctx = makeCtx({ llmStreamFactory: hangingFactory() });
    const first = startPrecompression(startOptions(ctx, session, pendingSeq, triggerMessageIndex));
    const second = startPrecompression(startOptions(ctx, session, pendingSeq, triggerMessageIndex));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error('unreachable');
    expect(second.job).toBe(first.job);
    // 任务体异步开流：flush 微任务后恰好一次调用
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ctx._llmCalls).toHaveLength(1);
    disposePrecompression(session.id);
    await first.job.promise;
  });

  it('不同 pendingSeq 启动替换旧任务：旧任务被中止', () => {
    const { session, pendingSeq, triggerMessageIndex } = fixtureSession();
    const ctx = makeCtx({ llmStreamFactory: hangingFactory() });
    const first = startPrecompression(startOptions(ctx, session, pendingSeq, triggerMessageIndex));
    const nextPendingSeq = appendOmEvent(session, 'om/observe-pending', { triggerMessageIndex });
    const second = startPrecompression(
      startOptions(ctx, session, nextPendingSeq, triggerMessageIndex),
    );
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error('unreachable');
    expect(second.job).not.toBe(first.job);
    expect(first.job.controller.signal.aborted).toBe(true);
    expect(peekPrecompressionJob(session.id)).toBe(second.job);
  });
});

describe('成功与持久化', () => {
  it('成功后写结果信封并 flush，不写压缩生命周期、不替换表层', async () => {
    const { session, pendingSeq, triggerMessageIndex } = fixtureSession();
    const nodesBefore = [...session.surface.nodes];
    const ctx = makeCtx({ llmStreamFactory: successFactory() });
    const started = startPrecompression(
      startOptions(ctx, session, pendingSeq, triggerMessageIndex),
    );
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error('unreachable');
    await started.job.promise;
    expect(started.job.state).toBe('done');
    const result = started.job.result;
    expect(result?.ok).toBe(true);
    expect(result?.text).toContain('</history>');
    // 结果信封：pendingSeq 匹配、report/provider/model 与循环结果一致、计时字段有限
    const summaries = findOmEvents(session, 'om/observe-summary');
    expect(summaries).toHaveLength(1);
    const data = summaries[0]?.data;
    expect(data?.pendingSeq).toBe(pendingSeq);
    expect(data?.report).toBe(result?.text);
    expect(data?.provider).toBe('test');
    expect(data?.model).toBe('test-model');
    expect(Number.isFinite(data?.startedAt)).toBe(true);
    expect(Number.isFinite(data?.completedAt)).toBe(true);
    expect(Number.isFinite(data?.durationMs)).toBe(true);
    expect(ctx._flushedSessions).toContain(session);
    // 任务不做注入：无 compaction/* 生命周期事件，表层节点不变
    expect(
      session.snapshotEvents().filter((event) => event.type.startsWith('compaction/')),
    ).toHaveLength(0);
    expect([...session.surface.nodes]).toEqual(nodesBefore);
  });

  it('压缩循环失败：登记 failed 与错误，不写结果信封', async () => {
    const { session, pendingSeq, triggerMessageIndex } = fixtureSession();
    const ctx = makeCtx({ llmStreamFactory: () => throwingStream('网络中断') });
    const started = startPrecompression(
      startOptions(ctx, session, pendingSeq, triggerMessageIndex),
    );
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error('unreachable');
    await started.job.promise;
    expect(started.job.state).toBe('failed');
    expect(started.job.failure?.error).toContain('网络中断');
    expect(started.job.failure?.aborted).toBe(false);
    expect(started.job.result).toBeUndefined();
    expect(findOmEvents(session, 'om/observe-summary')).toHaveLength(0);
    // 失败也落盘诊断记录（recordSessionId 随失败详情传播）
    expect(started.job.failure?.diagnosticSessionId).toBe(ctx._createdSessions[0]?.id);
  });

  it('sessions 服务未挂载：跳过 flush 仅记警告，done 登记不受影响', async () => {
    const { session, pendingSeq, triggerMessageIndex } = fixtureSession();
    const ctx = makeCtx({ sessionsMounted: false, llmStreamFactory: successFactory() });
    const started = startPrecompression(
      startOptions(ctx, session, pendingSeq, triggerMessageIndex),
    );
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error('unreachable');
    await started.job.promise;
    expect(started.job.state).toBe('done');
    expect(findOmEvents(session, 'om/observe-summary')).toHaveLength(1);
    expect(
      ctx._loggerCalls.some(
        (call) => call.level === 'warn' && String(call.args[0]).includes('sessions 服务未挂载'),
      ),
    ).toBe(true);
  });
});

describe('findPrecompressionJob 身份校验', () => {
  it('pendingSeq 不匹配：返回 undefined 并中止过期任务', () => {
    const { session, pendingSeq, triggerMessageIndex } = fixtureSession();
    const ctx = makeCtx({ llmStreamFactory: hangingFactory() });
    const started = startPrecompression(
      startOptions(ctx, session, pendingSeq, triggerMessageIndex),
    );
    if (!started.ok) throw new Error('unreachable');
    expect(findPrecompressionJob(session, pendingSeq + 999)).toBeUndefined();
    expect(started.job.controller.signal.aborted).toBe(true);
    expect(peekPrecompressionJob(session.id)).toBeUndefined();
  });

  it('会话对象被替换（重载）：返回 undefined 并中止旧任务', () => {
    const { session, pendingSeq, triggerMessageIndex } = fixtureSession();
    const ctx = makeCtx({ llmStreamFactory: hangingFactory() });
    const started = startPrecompression(
      startOptions(ctx, session, pendingSeq, triggerMessageIndex),
    );
    if (!started.ok) throw new Error('unreachable');
    const reloaded = makeSession({ events: [...session.snapshotEvents()] });
    expect(reloaded.id).toBe(session.id);
    expect(reloaded).not.toBe(session);
    expect(findPrecompressionJob(reloaded, pendingSeq)).toBeUndefined();
    expect(started.job.controller.signal.aborted).toBe(true);
  });

  it('无任务会话：返回 undefined', () => {
    const { session, pendingSeq } = fixtureSession();
    expect(findPrecompressionJob(session, pendingSeq)).toBeUndefined();
  });
});

describe('adoptPersistedSummary', () => {
  it('完整信封数据合成压缩成功结果（字段逐项映射）', () => {
    const adopted = adoptPersistedSummary({
      pendingSeq: 7,
      report: '<history>\n<user_message index="0">内容</user_message>\n</history>',
      provider: 'p1',
      model: 'm1',
      startedAt: 100,
      completedAt: 350,
      durationMs: 250,
      recordSessionId: 'rec-1',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      reasoningEffort: 'high',
    });
    expect(adopted.result.ok).toBe(true);
    expect(adopted.result.text).toContain('<history>');
    expect(adopted.result.stats).toEqual({
      startedAt: 100,
      completedAt: 350,
      durationMs: 250,
      rounds: [],
    });
    expect(adopted.result.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(adopted.result.recordSessionId).toBe('rec-1');
    expect(adopted.provider).toBe('p1');
    expect(adopted.model).toBe('m1');
    expect(adopted.reasoningEffort).toBe('high');
  });

  it('可选字段缺省时合成结果不携带对应键', () => {
    const adopted = adoptPersistedSummary({
      pendingSeq: 1,
      report: '<history />',
      provider: 'p',
      model: 'm',
      startedAt: 0,
      completedAt: 1,
      durationMs: 1,
    });
    expect(adopted.result.usage).toBeUndefined();
    expect(adopted.result.recordSessionId).toBeUndefined();
    expect(adopted.reasoningEffort).toBeUndefined();
  });
});

describe('disposeAllPrecompressions', () => {
  it('中止并移除全部会话的任务', () => {
    const ctx = makeCtx({ llmStreamFactory: hangingFactory() });
    const a = fixtureSession();
    const b = fixtureSession();
    Object.defineProperty(b.session, 'id', { value: 'other-session' });
    const jobA = startPrecompression(
      startOptions(ctx, a.session, a.pendingSeq, a.triggerMessageIndex),
    );
    const jobB = startPrecompression(
      startOptions(ctx, b.session, b.pendingSeq, b.triggerMessageIndex),
    );
    if (!jobA.ok || !jobB.ok) throw new Error('unreachable');
    disposeAllPrecompressions();
    expect(jobA.job.controller.signal.aborted).toBe(true);
    expect(jobB.job.controller.signal.aborted).toBe(true);
    expect(peekPrecompressionJob(a.session.id)).toBeUndefined();
    expect(peekPrecompressionJob('other-session')).toBeUndefined();
  });
});
