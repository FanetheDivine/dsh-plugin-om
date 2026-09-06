// 工具压缩循环单测：多轮工具调用执行、completeCompression 立即停止、纯文本提醒与
// 失败、429 限流重试、流终态错误、signal 中止、usage 汇总与会话记录落盘。
import { describe, expect, it } from 'vitest';
import {
  buildCompressionPrompt,
  buildCompressionTaskText,
  COMPRESSION_NUDGE_TEXT,
  type CompressionLoopOptions,
  runCompressionLoop,
} from '../src/compress-loop.ts';
import type { CompressionView, ViewEntry } from '../src/compress-view.ts';
import { COMPACTION_ABORTED_ERROR, HISTORY_TAG } from '../src/constants.ts';
import { resetRateLimitGate } from '../src/rate-limit.ts';
import { makeCtx, makeSession, roundChunks, throwingStream } from './helpers.ts';

/** 构造测试视图：0 用户 / 1-2 assistant。 */
function testView(): CompressionView {
  const entries: ViewEntry[] = [
    { kind: 'user', lo: 0, hi: 0, text: '用户消息' },
    { kind: 'assistant', lo: 1, hi: 1, text: '助手B' },
    { kind: 'assistant', lo: 2, hi: 2, text: '助手C' },
  ];
  return { entries, minIndex: 0, maxIndex: 2 };
}

/** 构造循环选项（rateLimitWaitMs=0 关闭限流等待）。 */
function loopOptions(overrides: Partial<CompressionLoopOptions> = {}): CompressionLoopOptions {
  return {
    view: testView(),
    phase: 'observe',
    taskText: '压缩完整消息区间 [0..2]',
    target: { provider: 'test', model: 'test-model' },
    maxTokens: undefined,
    rateLimitWaitMs: 0,
    skipReasoning: true,
    debug: false,
    ...overrides,
  };
}

describe('buildCompressionPrompt / buildCompressionTaskText', () => {
  it('skipReasoning=true 省略 <reasoning> 说明行，false 保留', () => {
    expect(buildCompressionPrompt(true)).not.toContain('<reasoning>');
    expect(buildCompressionPrompt(false)).toContain('<reasoning> 仅作压缩参考，不进产物。');
  });

  it('任务文本含区间：观察与反思各自表述', () => {
    expect(buildCompressionTaskText('observe', 3, 8)).toContain('[3..8]');
    expect(buildCompressionTaskText('observe', 3, 8)).not.toContain('<history>');
    expect(buildCompressionTaskText('reflect', 0, 12)).toContain('<history>');
    expect(buildCompressionTaskText('reflect', 0, 12)).toContain('[0..12]');
  });
});

describe('runCompressionLoop', () => {
  it('基本流程：getHistory → compressHistory → completeCompression，成功构建最终块并落盘会话记录', async () => {
    const ctx = makeCtx({
      llmStreamFactory: (index) => {
        if (index === 0)
          return roundChunks({ calls: [{ id: 't1', name: 'getHistory', args: {} }] });
        if (index === 1)
          return roundChunks({
            calls: [
              { id: 't2', name: 'compressHistory', args: { index: 1, content: 'B的摘要' } },
              { id: 't3', name: 'compressHistory', args: { index: 2, content: 'C的摘要' } },
            ],
          });
        return roundChunks({ calls: [{ id: 't4', name: 'completeCompression' }] });
      },
    });
    const session = makeSession();
    const result = await runCompressionLoop(ctx, session, loopOptions());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rounds).toBe(3);
    expect(result.text).toContain(`<${HISTORY_TAG} tip=`);
    expect(result.text).toContain('<user_message index="0">用户消息</user_message>');
    expect(result.text).toContain('<assistant index="1">B的摘要</assistant>');
    expect(result.text).toContain('<assistant index="2">C的摘要</assistant>');
    // 会话记录子会话：label 含阶段与轮数，消息组原样落盘并 flush
    expect(ctx._createdSessions).toHaveLength(1);
    const record = ctx._createdSessions[0];
    expect(
      String((record?.options as { meta?: { parentSession?: string } })?.meta?.parentSession),
    ).toBe(session.id);
    const events = record?.session.events ?? [];
    const descriptor = events.find((e) => e.type === 'subagent/descriptor');
    expect((descriptor?.data as { label?: string })?.label).toContain('会话记录');
    expect((descriptor?.data as { label?: string })?.label).toContain('3 轮');
    // 消息组：user 指令 + assistant(tool-call) + tool-result 逐条原样
    expect(events.filter((e) => e.type === 'user/message')).toHaveLength(5);
    expect(events.filter((e) => e.type === 'assistant/message')).toHaveLength(3);
    expect(ctx._flushedSessions).toHaveLength(1);
    expect(result.recordSessionId).toBe(record?.id);
  });

  it('请求选项：system 为共享提示词、携带压缩工具、purpose=compaction、首条消息为任务文本', async () => {
    const ctx = makeCtx({
      llmStreamFactory: () => roundChunks({ calls: [{ id: 't1', name: 'completeCompression' }] }),
    });
    await runCompressionLoop(ctx, makeSession(), loopOptions({ maxTokens: 123 }));
    expect(ctx._llmCalls).toHaveLength(1);
    const options = ctx._llmCalls[0]?.options as {
      system?: string;
      tools?: Array<{ name: string }>;
      purpose?: string;
      maxTokens?: number;
      messages?: Array<{ content?: Array<{ type: string; text?: string }> }>;
    };
    expect(options.system).toContain('compressHistory');
    expect(options.tools?.map((t) => t.name)).toEqual([
      'getHistory',
      'compressHistory',
      'completeCompression',
    ]);
    expect(options.purpose).toBe('compaction');
    expect(options.maxTokens).toBe(123);
    expect(options.messages?.[0]?.content?.[0]?.text).toBe('压缩完整消息区间 [0..2]');
  });

  it('completeCompression 调用后立即停止：同轮后续工具调用不再执行', async () => {
    const ctx = makeCtx({
      llmStreamFactory: () =>
        roundChunks({
          calls: [
            { id: 't1', name: 'completeCompression' },
            { id: 't2', name: 'getHistory', args: {} },
          ],
        }),
    });
    const result = await runCompressionLoop(ctx, makeSession(), loopOptions());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rounds).toBe(1);
    // 只发起一轮请求；getHistory（t2）未执行，无对应 tool-result（assistant 消息原样保留其调用块）
    expect(ctx._llmCalls).toHaveLength(1);
    const events = ctx._createdSessions[0]?.session.events ?? [];
    expect(events.filter((e) => e.type === 'user/message')).toHaveLength(2); // 指令 + completeCompression 结果
    expect(events.filter((e) => e.type === 'assistant/message')).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain('"toolCallId":"t2"');
  });

  it('空提交允许：直接 completeCompression 成功，最终块为原样条目', async () => {
    const ctx = makeCtx({
      llmStreamFactory: () => roundChunks({ calls: [{ id: 't1', name: 'completeCompression' }] }),
    });
    const result = await runCompressionLoop(ctx, makeSession(), loopOptions());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain('<assistant index="1">助手B</assistant>');
    // 空提交记 warn 日志
    expect(
      ctx._loggerCalls.some((c) => c.level === 'warn' && c.args.join('').includes('空提交')),
    ).toBe(true);
  });

  it('未知工具返回错误结果并继续循环', async () => {
    const ctx = makeCtx({
      llmStreamFactory: (index) => {
        if (index === 0) return roundChunks({ calls: [{ id: 't1', name: 'badTool' }] });
        return roundChunks({ calls: [{ id: 't2', name: 'completeCompression' }] });
      },
    });
    const result = await runCompressionLoop(ctx, makeSession(), loopOptions());
    expect(result.ok).toBe(true);
    const second = ctx._llmCalls[1];
    const messages = second ? (second.options as { messages?: unknown[] }).messages : undefined;
    expect(JSON.stringify(messages)).toContain('未知工具 badTool');
  });

  it('纯文本输出：追加提醒继续，连续 2 轮仍无工具调用判失败并落盘失败日志', async () => {
    const ctx = makeCtx({
      llmStreamFactory: () => roundChunks({ text: '我认为不需要压缩' }),
    });
    const session = makeSession();
    const result = await runCompressionLoop(ctx, session, loopOptions());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('未调用压缩工具');
    expect(result.aborted).toBe(false);
    expect(ctx._llmCalls).toHaveLength(2);
    // 第二轮请求末尾追加了提醒消息
    const second = ctx._llmCalls[1];
    const messages = second ? (second.options as { messages?: unknown[] }).messages : undefined;
    expect(JSON.stringify(messages)).toContain(COMPRESSION_NUDGE_TEXT);
    // 失败也落盘会话记录，label 为失败日志
    const descriptor = ctx._createdSessions[0]?.session.events.find(
      (e) => e.type === 'subagent/descriptor',
    );
    expect((descriptor?.data as { label?: string })?.label).toContain('失败日志');
    expect(result.recordSessionId).toBe(ctx._createdSessions[0]?.id);
  });

  it('请求抛 429 限流：记录限流后重试同一会话', async () => {
    resetRateLimitGate();
    const ctx = makeCtx({
      llmStreamFactory: (index) => {
        if (index === 0) return throwingStream('429 rate limit exceeded');
        return roundChunks({ calls: [{ id: 't1', name: 'completeCompression' }] });
      },
    });
    const result = await runCompressionLoop(ctx, makeSession(), loopOptions());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rounds).toBe(1); // 429 轮不计入
    expect(ctx._llmCalls).toHaveLength(2);
  });

  it('流以非 429 的 error 终态结束：判失败并携带错误信息', async () => {
    const ctx = makeCtx({
      llmStreamFactory: () =>
        roundChunks({ finish: { kind: 'error', failure: { message: 'provider boom' } } }),
    });
    const result = await runCompressionLoop(ctx, makeSession(), loopOptions());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('provider boom');
    expect(result.aborted).toBe(false);
  });

  it('流以 error 终态结束且带部分文本输出：部分输出计入会话记录（诊断价值）', async () => {
    const ctx = makeCtx({
      llmStreamFactory: () =>
        roundChunks({ text: '部分输出', finish: { kind: 'error', failure: { message: 'boom' } } }),
    });
    const result = await runCompressionLoop(ctx, makeSession(), loopOptions());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // 会话记录：指令 + assistant（部分输出原样）
    const events = ctx._createdSessions[0]?.session.events ?? [];
    const assistantEvents = events.filter((e) => e.type === 'assistant/message');
    expect(assistantEvents).toHaveLength(1);
    expect(JSON.stringify(assistantEvents)).toContain('部分输出');
  });

  it('流以 error 终态结束但无 failure 详情：以兜底描述失败，不抛错', async () => {
    const ctx = makeCtx({
      llmStreamFactory: () => roundChunks({ finish: { kind: 'error' } }),
    });
    const result = await runCompressionLoop(ctx, makeSession(), loopOptions());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('流以 error 终态结束（无失败详情）');
    expect(result.aborted).toBe(false);
  });

  it('signal 已中止：不发请求直接失败（aborted）', async () => {
    const ctx = makeCtx({
      llmStreamFactory: () => roundChunks({ calls: [{ id: 't1', name: 'completeCompression' }] }),
    });
    const controller = new AbortController();
    controller.abort();
    const result = await runCompressionLoop(
      ctx,
      makeSession(),
      loopOptions({ signal: controller.signal }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(COMPACTION_ABORTED_ERROR);
    expect(result.aborted).toBe(true);
    expect(ctx._llmCalls).toHaveLength(0);
  });

  it('usage 汇总全部轮次', async () => {
    const ctx = makeCtx({
      llmStreamFactory: (index) => {
        if (index === 0)
          return roundChunks({
            calls: [{ id: 't1', name: 'getHistory' }],
            usage: { inputTokens: 100, outputTokens: 10 },
          });
        return roundChunks({
          calls: [{ id: 't2', name: 'completeCompression' }],
          usage: { inputTokens: 200, outputTokens: 20 },
        });
      },
    });
    const result = await runCompressionLoop(ctx, makeSession(), loopOptions());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.usage).toEqual({ inputTokens: 300, outputTokens: 30 });
  });
});
