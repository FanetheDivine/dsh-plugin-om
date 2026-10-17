// 工具压缩循环单测：多轮工具调用执行、completeCompression 立即停止、纯文本提醒与
// 失败、429 限流重试、流终态错误、signal 中止、usage 汇总与会话记录落盘。
import type { GenerateOptions, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { describe, expect, it } from 'vitest';
import {
  buildCompressionPrompt,
  buildCompressionTaskText,
  COMPRESSION_NUDGE_TEXT,
  type CompressionLoopOptions,
  REFLECT_COMPRESSION_PROMPT,
  runCompressionLoop,
  TRUNCATION_NUDGE_TEXT,
  withoutReasoning,
} from '../src/compress-loop.ts';
import { buildReflectView, type CompressionView, type ViewEntry } from '../src/compress-view.ts';
import {
  COMPACTION_ABORTED_ERROR,
  COMPLETE_MESSAGE_DEFINITION,
  HISTORY_TAG,
} from '../src/constants.ts';
import { formatCompactCount } from '../src/format.ts';
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

/** 含 reasoning 参考条目的预建视图：0 用户 / 1 assistant（其前带 reasoning）。 */
function reasoningView(): CompressionView {
  const entries: ViewEntry[] = [
    { kind: 'user', lo: 0, hi: 0, text: '用户消息' },
    { kind: 'reasoning', lo: 1, hi: 1, text: '其他模型的思考' },
    { kind: 'assistant', lo: 1, hi: 1, text: '助手B' },
  ];
  return { entries, minIndex: 0, maxIndex: 1 };
}

/** 带两条原始合法 ask 的视图，覆盖混合处理路径。 */
function askView(): CompressionView {
  const makeAsk = (index: number, answer: string): ViewEntry => ({
    kind: 'assistant',
    lo: index,
    hi: index,
    toolName: 'ask_user_question',
    text: '',
    ask: {
      questions: [
        {
          question: '采用哪种发布方式？',
          options: [
            { label: '灰度发布', description: '先向少量用户开放' },
            { label: '全量发布', description: '一次向所有用户开放' },
          ],
          answer,
        },
      ],
    },
  });
  return { entries: [makeAsk(1, '第一个'), makeAsk(2, '(未回答)')], minIndex: 1, maxIndex: 2 };
}

/** 模拟已展开选项引用的逐题重写提交。 */
function rewriteCall(index = 1) {
  return {
    id: `rewrite-${index}`,
    name: 'rewriteAskUserQuestion',
    args: {
      index,
      qa: [
        {
          ordinal: 1,
          q: '采用哪种发布方式？',
          a: index === 1 ? '采用灰度发布，先向少量用户开放。' : '(未回答)',
        },
      ],
    },
  };
}

describe('原始 ask 的循环处理', () => {
  it('拒绝提前完成和同轮提前重写，下一轮看到选项后可以重写完成', async () => {
    const view = askView();
    view.entries = view.entries.slice(0, 1);
    view.maxIndex = 1;
    const ctx = makeCtx({
      llmStreamFactory: (round, rawOptions) => {
        const options = rawOptions as GenerateOptions;
        if (round === 0)
          return roundChunks({
            calls: [
              { id: 'early', name: 'completeCompression' },
              { id: 'view', name: 'getHistory' },
              { ...rewriteCall(), id: 'premature-rewrite' },
            ],
          });
        expect(JSON.stringify(options.messages)).toContain('o1:灰度发布');
        expect(JSON.stringify(options.messages)).toContain('先向少量用户开放');
        return roundChunks({
          calls: [
            rewriteCall(),
            { id: 'done', name: 'completeCompression' },
            { id: 'not-started', name: 'getHistory' },
          ],
        });
      },
    });
    const result = await runCompressionLoop(ctx, makeSession(), loopOptions({ view }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rounds).toBe(2);
    expect(result.text).toContain('a:采用灰度发布，先向少量用户开放。');
    expect(result.text).not.toContain('o1:');
    expect(result.text).not.toContain('全量发布');
    const options = ctx._llmCalls[0]?.options as GenerateOptions;
    expect(options.tools?.map((t) => t.name)).toContain('rewriteAskUserQuestion');
    expect(options.system).toContain('rewriteAskUserQuestion');
    expect(options.system).toContain('o1:');
    const secondOptions = ctx._llmCalls[1]?.options as GenerateOptions | undefined;
    expect(secondOptions?.tools).toEqual(options.tools);
    expect(
      ctx._loggerCalls.some((c) => c.level === 'warn' && c.args.join('').includes('空提交')),
    ).toBe(false);
    const events = ctx._createdSessions[0]?.session.snapshotEvents() ?? [];
    expect(
      events.find((e) => e.type === 'tool/result' && e.data.message.toolCallId === 'early'),
    ).toMatchObject({ data: { message: { isError: true } } });
    expect(
      events.find(
        (e) => e.type === 'tool/result' && e.data.message.toolCallId === 'premature-rewrite',
      ),
    ).toMatchObject({ data: { message: { isError: true } } });
    expect(
      events.find((e) => e.type === 'tool/result' && e.data.message.toolCallId === 'rewrite-1'),
    ).toMatchObject({ data: { message: { isError: false } } });
    expect(
      events.find((e) => e.type === 'tool/result' && e.data.message.toolCallId === 'not-started'),
    ).toMatchObject({ data: { error: { code: 'TOOL_NOT_STARTED' } } });
  });

  it('直接压缩首次被阻止，再次成功，无需重写也能完成', async () => {
    const ctx = makeCtx({
      llmStreamFactory: (round) => {
        if (round === 0)
          return roundChunks({
            calls: [
              { id: 'view', name: 'getHistory' },
              {
                id: 'first',
                name: 'compressHistory',
                args: { start: 1, end: 2, content: '发布决策摘要' },
              },
              { id: 'early', name: 'completeCompression' },
            ],
          });
        if (round === 1)
          return roundChunks({
            calls: [
              {
                id: 'second',
                name: 'compressHistory',
                args: { start: 1, end: 2, content: '发布决策摘要' },
              },
              { id: 'done', name: 'completeCompression' },
            ],
          });
        return roundChunks({ text: '不应继续请求' });
      },
    });
    const result = await runCompressionLoop(ctx, makeSession(), loopOptions({ view: askView() }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rounds).toBe(2);
    expect(result.text).toContain(
      '<assistant start="1" end="2"><![CDATA[发布决策摘要]]></assistant>',
    );
    expect(result.text).not.toContain('<ask-user-question');
  });

  it('一条直接压缩，另一条重写，输出各自的最终结果', async () => {
    const ctx = makeCtx({
      llmStreamFactory: (round) => {
        if (round === 0) return roundChunks({ calls: [{ id: 'view', name: 'getHistory' }] });
        if (round === 1)
          return roundChunks({
            calls: [
              {
                id: 'first',
                name: 'compressHistory',
                args: { index: 1, content: '采用灰度发布' },
              },
              {
                id: 'second',
                name: 'compressHistory',
                args: { index: 1, content: '采用灰度发布' },
              },
              rewriteCall(2),
              { id: 'done', name: 'completeCompression' },
            ],
          });
        return roundChunks({ text: '不应继续请求' });
      },
    });
    const result = await runCompressionLoop(ctx, makeSession(), loopOptions({ view: askView() }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain('<assistant index="1"><![CDATA[采用灰度发布]]></assistant>');
    expect(result.text).toContain('<ask-user-question index="2">');
    expect(result.text).toContain('a:(未回答)');
    expect(result.text).not.toContain('o1:');
  });

  it.each(['invalid', 'history'] as const)('%s ask 不注入新增工具，允许原样完成', async (kind) => {
    const view =
      kind === 'history'
        ? buildReflectView([
            {
              seq: 9,
              text: '<history><ask-user-question index="1"><![CDATA[q:继续吗\na:继续]]></ask-user-question></history>',
            },
          ])
        : {
            entries: [
              {
                kind: 'assistant' as const,
                lo: 1,
                hi: 1,
                text: '',
                toolName: 'ask_user_question',
                callId: 'invalid',
                toolArgs: '{"questions":[]}',
                toolResult: 'Error: aborted',
              },
            ],
            minIndex: 1,
            maxIndex: 1,
          };
    const ctx = makeCtx({
      llmStreamFactory: () => roundChunks({ calls: [{ id: 'done', name: 'completeCompression' }] }),
    });
    const result = await runCompressionLoop(
      ctx,
      makeSession(),
      loopOptions({ view, phase: kind === 'history' ? 'reflect' : 'observe' }),
    );
    expect(result.ok).toBe(true);
    const options = ctx._llmCalls[0]?.options as GenerateOptions;
    expect(options.tools?.map((t) => t.name)).toEqual([
      'getHistory',
      'compressHistory',
      'completeCompression',
    ]);
    expect(options.system).not.toContain('rewriteAskUserQuestion');
    if (!result.ok) return;
    expect(result.text).toContain(kind === 'history' ? 'a:继续' : 'Error: aborted');
  });

  it.each(['error', 'aborted', 'text'] as const)(
    '部分重写后 %s：失败不返回部分产物',
    async (failure) => {
      const ctx = makeCtx({
        llmStreamFactory: (round) => {
          if (round === 0) return roundChunks({ calls: [{ id: 'view', name: 'getHistory' }] });
          if (round === 1) return roundChunks({ calls: [rewriteCall()] });
          if (failure === 'text') return roundChunks({ text: '无法继续' });
          return roundChunks({
            finish:
              failure === 'error'
                ? { kind: 'error', failure: { message: 'provider boom' } }
                : { kind: 'aborted' },
          });
        },
      });
      const result = await runCompressionLoop(ctx, makeSession(), loopOptions({ view: askView() }));
      expect(result.ok).toBe(false);
      expect(result).not.toHaveProperty('text');
      if (result.ok) return;
      expect(result.aborted).toBe(failure === 'aborted');
      const events = ctx._createdSessions[0]?.session.snapshotEvents() ?? [];
      expect(
        events.find((e) => e.type === 'tool/result' && e.data.message.toolCallId === 'rewrite-1'),
      ).toMatchObject({ data: { message: { isError: false } } });
    },
  );
});

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

  it('ask_user_question 条目规则：提示词包含条目形态与保护性要求', () => {
    const prompt = buildCompressionPrompt(true);
    // 提示词点名工具名与条目元素，并给出与 skill 同形的条件保护（无关才压缩、否则保持原文）
    expect(prompt).toContain('ask_user_question');
    expect(prompt).toContain('<ask-user-question index="N">');
    expect(prompt).toContain('q:');
    expect(prompt).toContain('a:');
    expect(prompt).not.toContain('<askuserquestion');
  });

  it('摘要粒度按后续用途分配：不按消息位置区分详略', () => {
    const prompt = buildCompressionPrompt(true);
    expect(prompt).not.toMatch(/越往后|靠近末尾|开头.*简写/);
    expect(prompt).toContain('与消息位置无关');
    expect(prompt).not.toContain(REFLECT_COMPRESSION_PROMPT); // 反思约束不进共享提示词
  });

  it('压缩子会话看不到主会话提醒：提示词自带完整消息定义', () => {
    expect(buildCompressionPrompt(true)).toContain(COMPLETE_MESSAGE_DEFINITION);
  });

  it('任务文本含区间：观察与反思各自表述', () => {
    expect(buildCompressionTaskText('observe', 3, 8)).toContain('[3..8]');
    expect(buildCompressionTaskText('observe', 3, 8)).not.toContain('<history>');
    expect(buildCompressionTaskText('reflect', 0, 12)).toContain('<history>');
    expect(buildCompressionTaskText('reflect', 0, 12)).toContain('[0..12]');
  });
});

describe('withoutReasoning', () => {
  it('skipReasoning=true 去掉 reasoning 条目并保留其余条目与区间，false 原样返回', () => {
    const view = reasoningView();
    const stripped = withoutReasoning(view, true);
    expect(stripped.entries.map((e) => e.kind)).toEqual(['user', 'assistant']);
    expect([stripped.minIndex, stripped.maxIndex]).toEqual([0, 1]);
    expect(withoutReasoning(view, false)).toBe(view);
  });
});

describe('runCompressionLoop', () => {
  it.each([
    [true, false],
    [false, true],
  ])(
    '预建视图带 reasoning 时：skipReasoning=%s，getHistory 输出含 reasoning=%s',
    async (skip, shown) => {
      const ctx = makeCtx({
        llmStreamFactory: (index) =>
          index === 0
            ? roundChunks({ calls: [{ id: 't1', name: 'getHistory', args: {} }] })
            : roundChunks({ calls: [{ id: 't2', name: 'completeCompression' }] }),
      });
      await runCompressionLoop(
        ctx,
        makeSession(),
        loopOptions({ view: reasoningView(), skipReasoning: skip }),
      );
      const events = ctx._createdSessions[0]?.session.snapshotEvents() ?? [];
      const historyResult = events.find((e) => e.type === 'tool/result');
      expect(JSON.stringify(historyResult?.data).includes('其他模型的思考')).toBe(shown);
    },
  );

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
    expect(result.text).toContain('<user_message index="0"><![CDATA[用户消息]]></user_message>');
    expect(result.text).toContain('<assistant index="1"><![CDATA[B的摘要]]></assistant>');
    expect(result.text).toContain('<assistant index="2"><![CDATA[C的摘要]]></assistant>');
    // 会话记录子会话：label 含区间与阶段（testView 区间 0-2），消息组原样落盘并 flush
    expect(ctx._createdSessions).toHaveLength(1);
    const record = ctx._createdSessions[0];
    expect(
      String((record?.options as { meta?: { parentSession?: string } })?.meta?.parentSession),
    ).toBe(session.id);
    const events = record?.session.snapshotEvents() ?? [];
    const descriptor = events.find((e) => e.type === 'subagent/descriptor');
    expect((descriptor?.data as { label?: string })?.label).toBe('OM会话(0-2)-观察');
    // 消息组：user 指令为唯一 user/message，工具结果（getHistory、
    // 两次 compressHistory、completeCompression 共 4 条）为 tool/result；
    // assistant/message 为 3 轮模型输出 + 尾部 1 条模型信息
    expect(events.filter((e) => e.type === 'user/message')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'assistant/message')).toHaveLength(4);
    expect(events.filter((e) => e.type === 'tool/result')).toHaveLength(4);
    // 助手消息归因：source 精确为模型产出标识（provider/model 与 target 一致，无多余字段）
    for (const e of events.filter((e) => e.type === 'assistant/message')) {
      expect((e.data as { message?: { source?: unknown } }).message?.source).toEqual({
        kind: 'model',
        provider: 'test',
        model: 'test-model',
      });
    }
    // completeCompression 的 tool/result 落盘为最终 <history> 块，会话记录里可直接查看
    const lastResult = events.filter((e) => e.type === 'tool/result').at(-1);
    const persisted = JSON.stringify(lastResult?.data);
    expect(persisted).toContain(`<${HISTORY_TAG} tip=`);
    expect(persisted).toContain('B的摘要');
    expect(persisted).not.toContain('压缩完成');
    expect(ctx._flushedSessions).toHaveLength(1);
    expect(result.recordSessionId).toBe(record?.id);
  });

  it('会话记录尾部追加模型文本：压缩模型、思考等级、原始与产物字符数（k 单位）', async () => {
    /** 取子会话最后一条 assistant/message（模型信息）的文本与来源。 */
    const tailOf = (ctx: ReturnType<typeof makeCtx>) => {
      const events = ctx._createdSessions[0]?.session.snapshotEvents() ?? [];
      const last = events.findLast((e) => e.type === 'assistant/message');
      if (last?.type !== 'assistant/message') throw new Error('缺 assistant/message 事件');
      return { text: JSON.stringify(last.data.message.content), source: last.data.message.source };
    };

    const okCtx = makeCtx({
      llmStreamFactory: () => roundChunks({ calls: [{ id: 't1', name: 'completeCompression' }] }),
    });
    const ok = await runCompressionLoop(
      okCtx,
      makeSession(),
      loopOptions({ reasoningEffort: 'high' as ReasoningEffortId }),
    );
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    const tail = tailOf(okCtx);
    // 原始消息 = 视图条目文本 4 + 3 + 3 = 10；产物 = 最终 <history> 块长度
    expect(tail.text).toContain('压缩使用模型 test/test-model（high）');
    expect(tail.text).toContain('原始消息 10 字符');
    expect(tail.text).toContain(`压缩产物 ${formatCompactCount(ok.text.length)} 字符`);
    // 模型来源（非插件来源），时间线尾部为 step/start → assistant/message → step/end → turn/end
    expect(tail.source).toEqual({ kind: 'model', provider: 'test', model: 'test-model' });
    expect(
      (okCtx._createdSessions[0]?.session.snapshotEvents() ?? []).map((e) => e.type).slice(-4),
    ).toEqual(['step/start', 'assistant/message', 'step/end', 'turn/end']);
    // 指令仍是唯一的 user/message
    expect(
      (okCtx._createdSessions[0]?.session.snapshotEvents() ?? []).filter(
        (e) => e.type === 'user/message',
      ),
    ).toHaveLength(1);

    const defaultCtx = makeCtx({
      llmStreamFactory: () => roundChunks({ calls: [{ id: 't1', name: 'completeCompression' }] }),
    });
    await runCompressionLoop(defaultCtx, makeSession(), loopOptions());
    expect(tailOf(defaultCtx).text).toContain('压缩使用模型 test/test-model（默认思考等级）');

    const failCtx = makeCtx({ llmStreamFactory: () => roundChunks({ text: '纯文本' }) });
    const failed = await runCompressionLoop(failCtx, makeSession(), loopOptions());
    expect(failed.ok).toBe(false);
    expect(tailOf(failCtx).text).toContain('原始消息 10 字符');
    expect(tailOf(failCtx).text).toContain('压缩产物 无（压缩失败）');
  });

  it('retry 透传到会话记录标题：成功与失败均带重压缩后缀', async () => {
    /** 读取首个落盘子会话的 descriptor label。 */
    const labelOf = (ctx: ReturnType<typeof makeCtx>): string | undefined => {
      const data = ctx._createdSessions[0]?.session
        .snapshotEvents()
        .find((e) => e.type === 'subagent/descriptor')?.data;
      return (data as { label?: string } | undefined)?.label;
    };
    const completing = () =>
      makeCtx({
        llmStreamFactory: () => roundChunks({ calls: [{ id: 't1', name: 'completeCompression' }] }),
      });

    const okCtx = completing();
    const ok = await runCompressionLoop(okCtx, makeSession(), { ...loopOptions(), retry: true });
    expect(ok.ok).toBe(true);
    expect(labelOf(okCtx)).toBe('OM会话(0-2)-观察-重压缩');

    const failCtx = makeCtx({ llmStreamFactory: () => roundChunks({ text: '纯文本' }) });
    const failed = await runCompressionLoop(failCtx, makeSession(), {
      ...loopOptions(),
      retry: true,
    });
    expect(failed.ok).toBe(false);
    expect(labelOf(failCtx)).toBe('OM会话(0-2)-观察-重压缩-失败');

    const plainCtx = completing();
    await runCompressionLoop(plainCtx, makeSession(), loopOptions());
    expect(labelOf(plainCtx)).toBe('OM会话(0-2)-观察');
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

  it('会话记录：压缩系统提示词落盘为 system/message，任务指令为用户来源', async () => {
    const ctx = makeCtx({
      llmStreamFactory: () => roundChunks({ calls: [{ id: 't1', name: 'completeCompression' }] }),
    });
    await runCompressionLoop(ctx, makeSession(), loopOptions());
    const events = ctx._createdSessions[0]?.session.snapshotEvents() ?? [];
    const sysData = events.find((e) => e.type === 'system/message')?.data as {
      turn?: number;
      step?: number;
      message?: { content?: unknown };
    };
    expect(sysData).toMatchObject({ turn: 1, step: 1 });
    expect(JSON.stringify(sysData.message?.content)).toContain('compressHistory');
    const userSource = events
      .filter((e) => e.type === 'user/message')
      .map((e) => (e.data as { source?: { kind?: string } }).source)[0];
    expect(userSource).toEqual({ kind: 'user' });
  });

  it('反思 pass 在 system 追加反思合并约束，观察 pass 不追加', async () => {
    const systemOf = async (phase: 'observe' | 'reflect') => {
      const ctx = makeCtx({
        llmStreamFactory: () => roundChunks({ calls: [{ id: 't1', name: 'completeCompression' }] }),
      });
      await runCompressionLoop(ctx, makeSession(), loopOptions({ phase }));
      return (ctx._llmCalls[0]?.options as { system?: string } | undefined)?.system;
    };
    expect(await systemOf('reflect')).toBe(
      `${buildCompressionPrompt(true)}\n\n${REFLECT_COMPRESSION_PROMPT}`,
    );
    expect(await systemOf('observe')).toBe(buildCompressionPrompt(true));
  });

  it('requestOptions 条件携带 reasoningEffort：配置时透传，未配置时不带该键', async () => {
    const withEffort = makeCtx({
      llmStreamFactory: () => roundChunks({ calls: [{ id: 't1', name: 'completeCompression' }] }),
    });
    await runCompressionLoop(
      withEffort,
      makeSession(),
      loopOptions({ reasoningEffort: 'mid' as ReasoningEffortId }),
    );
    const withEffortOptions = withEffort._llmCalls[0]?.options as {
      reasoningEffort?: string;
    };
    expect(withEffortOptions.reasoningEffort).toBe('mid');
    const withoutEffort = makeCtx({
      llmStreamFactory: () => roundChunks({ calls: [{ id: 't1', name: 'completeCompression' }] }),
    });
    await runCompressionLoop(withoutEffort, makeSession(), loopOptions());
    expect(withoutEffort._llmCalls[0]?.options).not.toHaveProperty('reasoningEffort');
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
    // 只发起一轮请求；getHistory（t2）未执行，无对应 tool/result（assistant 消息原样保留其调用块）
    expect(ctx._llmCalls).toHaveLength(1);
    const events = ctx._createdSessions[0]?.session.snapshotEvents() ?? [];
    // 指令为唯一 user/message；assistant/message 为 1 轮模型输出 + 尾部模型信息
    expect(events.filter((e) => e.type === 'user/message')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'assistant/message')).toHaveLength(2);
    // 压缩只执行 completeCompression，未执行的 t2 被补为可冷读取的失败结果。
    expect(events.filter((e) => e.type === 'tool/result')).toHaveLength(2);
    expect(
      events.find((e) => e.type === 'tool/result' && e.data.message.toolCallId === 't2'),
    )?.toMatchObject({ data: { error: { code: 'TOOL_NOT_STARTED' } } });
  });

  it('空提交允许：直接 completeCompression 成功，最终块为原样条目', async () => {
    const ctx = makeCtx({
      llmStreamFactory: () => roundChunks({ calls: [{ id: 't1', name: 'completeCompression' }] }),
    });
    const result = await runCompressionLoop(ctx, makeSession(), loopOptions());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain('<assistant index="1"><![CDATA[助手B]]></assistant>');
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

  it('纯文本输出：追加提醒继续，连续 3 轮仍无工具调用判失败并落盘失败日志', async () => {
    const ctx = makeCtx({
      llmStreamFactory: () => roundChunks({ text: '我认为不需要压缩' }),
    });
    const session = makeSession();
    const result = await runCompressionLoop(ctx, session, loopOptions());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('模型连续 3 轮未调用压缩工具，放弃本次压缩');
    expect(result.aborted).toBe(false);
    expect(ctx._llmCalls).toHaveLength(3);
    // 第二轮请求末尾追加了提醒消息
    const second = ctx._llmCalls[1];
    const messages = second ? (second.options as { messages?: unknown[] }).messages : undefined;
    expect(JSON.stringify(messages)).toContain(COMPRESSION_NUDGE_TEXT);
    expect(JSON.stringify(messages)).not.toContain(TRUNCATION_NUDGE_TEXT);
    // 失败也落盘会话记录，label 追加失败后缀
    const descriptor = ctx._createdSessions[0]?.session
      .snapshotEvents()
      .find((e) => e.type === 'subagent/descriptor');
    expect((descriptor?.data as { label?: string })?.label).toBe('OM会话(0-2)-观察-失败');
    expect(result.recordSessionId).toBe(ctx._createdSessions[0]?.id);
  });

  it('纯文本两轮后正常调用工具：计数清零，之后再来两轮纯文本仍可继续', async () => {
    const ctx = makeCtx({
      llmStreamFactory: (index) => {
        if (index === 2) return roundChunks({ calls: [{ id: 'v', name: 'getHistory' }] });
        if (index === 5) return roundChunks({ calls: [{ id: 'c', name: 'completeCompression' }] });
        return roundChunks({ text: '纯文本' });
      },
    });
    const result = await runCompressionLoop(ctx, makeSession(), loopOptions());
    expect(result.ok).toBe(true);
    expect(ctx._llmCalls).toHaveLength(6);
  });

  it('max-tokens 截断：连续 3 轮判失败，错误指明截断而非未调用工具', async () => {
    const ctx = makeCtx({
      llmStreamFactory: () =>
        roundChunks({
          reasoning: '很长的思考'.repeat(100),
          usage: { inputTokens: 100, outputTokens: 32768 },
          finish: { kind: 'max-tokens' },
        }),
    });
    const result = await runCompressionLoop(ctx, makeSession(), loopOptions());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('模型连续 3 轮输出被 max-tokens 截断，放弃本次压缩');
    expect(result.aborted).toBe(false);
    expect(ctx._llmCalls).toHaveLength(3);
  });

  it('截断轮的 assistant 消息不进入后续请求，改用截断专用提醒，会话记录仍保留', async () => {
    const ctx = makeCtx({
      llmStreamFactory: (index) =>
        index === 0
          ? roundChunks({ reasoning: '巨型思考内容', finish: { kind: 'max-tokens' } })
          : roundChunks({ calls: [{ id: 'c', name: 'completeCompression' }] }),
    });
    const result = await runCompressionLoop(ctx, makeSession(), loopOptions());
    expect(result.ok).toBe(true);
    const second = ctx._llmCalls[1];
    const sent = JSON.stringify(
      (second ? (second.options as { messages?: unknown[] }) : {}).messages,
    );
    expect(sent).toContain(TRUNCATION_NUDGE_TEXT);
    expect(sent).not.toContain('巨型思考内容');
    expect(sent).not.toContain(COMPRESSION_NUDGE_TEXT);
    const events = ctx._createdSessions[0]?.session.snapshotEvents() ?? [];
    expect(JSON.stringify(events)).toContain('巨型思考内容');
    expect(JSON.stringify(events)).toContain(TRUNCATION_NUDGE_TEXT);
  });

  it('截断与纯文本各自计数、互不累加；正常调用工具后全部清零', async () => {
    // 截断、纯文本、截断、纯文本：两个计数都只到 2，不应失败
    const rounds = [
      { finish: { kind: 'max-tokens' }, reasoning: '思' },
      { text: '纯文本' },
      { finish: { kind: 'max-tokens' }, reasoning: '思' },
      { text: '纯文本' },
    ];
    const ctx = makeCtx({
      llmStreamFactory: (index) => {
        const scripted = rounds[index];
        if (scripted !== undefined) return roundChunks(scripted);
        return roundChunks({ calls: [{ id: 'c', name: 'completeCompression' }] });
      },
    });
    const result = await runCompressionLoop(ctx, makeSession(), loopOptions());
    expect(result.ok).toBe(true);
    expect(ctx._llmCalls).toHaveLength(5);
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
    const events = ctx._createdSessions[0]?.session.snapshotEvents() ?? [];
    const assistantEvents = events.filter((e) => e.type === 'assistant/message');
    // 部分输出原样 + 尾部模型信息
    expect(assistantEvents).toHaveLength(2);
    expect(JSON.stringify(assistantEvents[0])).toContain('部分输出');
    expect(JSON.stringify(assistantEvents[1])).toContain('压缩使用模型');
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
