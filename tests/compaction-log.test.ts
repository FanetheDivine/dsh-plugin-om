// compaction-log.ts 单元测试：压缩会话记录落盘 recordCompressionSession——以 seed 事件
// 重建时间线（turn/step 边界与 assistant 完成时刻取自循环统计）、逐轮 usage 附加到
// assistant/message、header 元数据（origin/parentSession/delegationDepth/cwd 继承）、
// subagent/descriptor 载荷、循环消息组结构与顺序、TOOL_NOT_STARTED 补齐、flush 调用、
// 落盘异常被吞（create/flush 失败仅 warn 不抛错）。

import { Context } from '@deepseek-ai/cordis';
import { SessionStore } from '@deepseek-ai/dsh-session';
import { SUBAGENT_DESCRIPTOR_VERSION } from '@deepseek-ai/dsh-subagent';
import { describe, expect, it } from 'vitest';

import {
  COMPACTION_LOG_PROVIDER,
  compressionRecordLabel,
  recordCompressionSession,
} from '../src/compaction-log.ts';
import type { CompressionStats } from '../src/compress-loop.ts';
import { PLUGIN_SOURCE_KIND } from '../src/constants.ts';
import type { Message, Session, SessionEvent, SessionEventMap, TokenUsage } from '../src/types.ts';
import { makeCtx, makeSession, textBlock, twoCallFlow } from './helpers.ts';

/** 构造循环统计：startedAt=1000、completedAt=6000，逐轮 startedAt 累加、耗时与 usage 可指定。 */
function makeStats(
  rounds: Array<{ durationMs: number; usage?: { inputTokens: number; outputTokens: number } }>,
): CompressionStats {
  const startedAt = 1_000;
  let cursor = startedAt;
  return {
    startedAt,
    completedAt: startedAt + 5_000,
    durationMs: 5_000,
    rounds: rounds.map((round, index) => {
      const roundStat = {
        round: index + 1,
        startedAt: cursor,
        durationMs: round.durationMs,
        ...(round.usage === undefined ? {} : { usage: round.usage }),
      };
      cursor += round.durationMs;
      return roundStat;
    }),
  };
}

/** 单轮循环消息组：user 指令 + assistant（tool-call c1）+ tool 结果消息。 */
function loopMessages(): Message[] {
  return [
    {
      id: 'm1' as never,
      role: 'user',
      content: [textBlock('压缩指令')],
      source: { kind: PLUGIN_SOURCE_KIND },
    } as unknown as Message,
    {
      id: 'm2' as never,
      role: 'assistant',
      content: [
        { type: 'text', text: '开始压缩' },
        { type: 'tool-call', id: 'c1' as never, name: 'getHistory', arguments: '{}' },
      ],
      source: { kind: 'model', provider: 'test', model: 'test-model' },
    } as unknown as Message,
    {
      id: 'm3' as never,
      role: 'tool',
      content: [textBlock('历史条目')],
      toolCallId: 'c1' as never,
      isError: false,
      source: { kind: 'tool', callId: 'c1' as never },
    } as unknown as Message,
  ];
}

/** 两轮循环消息组：assistant#1↔round1、assistant#2↔round2，用于时间线重建断言。 */
function twoRoundMessages(): Message[] {
  const user = {
    id: 'm1' as never,
    role: 'user',
    content: [textBlock('压缩指令')],
    source: { kind: PLUGIN_SOURCE_KIND },
  } as unknown as Message;
  const assistant = (id: string, text: string, callId: string, name: string): Message =>
    ({
      id: id as never,
      role: 'assistant',
      content: [
        { type: 'text', text },
        { type: 'tool-call', id: callId as never, name, arguments: '{}' },
      ],
      source: { kind: 'model', provider: 'test', model: 'test-model' },
    }) as unknown as Message;
  const tool = (id: string, callId: string, text: string): Message =>
    ({
      id: id as never,
      role: 'tool',
      content: [textBlock(text)],
      toolCallId: callId as never,
      isError: false,
      source: { kind: 'tool', callId: callId as never },
    }) as unknown as Message;
  return [
    user,
    assistant('m2', '第一轮', 'c1', 'getHistory'),
    tool('m3', 'c1', '历史条目'),
    assistant('m4', '第二轮', 'c2', 'completeCompression'),
    tool('m5', 'c2', '压缩完成'),
  ];
}

/** 断言辅助：取子会话事件中的 user/assistant/tool 消息（descriptor 占 seq 0）。 */
function messageEvents(child: Session): {
  user: SessionEvent[];
  assistant: SessionEvent[];
  tool: SessionEvent[];
} {
  return {
    user: child.snapshotEvents().filter((e) => e.type === 'user/message'),
    assistant: child.snapshotEvents().filter((e) => e.type === 'assistant/message'),
    tool: child.snapshotEvents().filter((e) => e.type === 'tool/result'),
  };
}

/** 断言辅助：取子会话指定类型事件的 time 序列。 */
function times(child: Session | undefined, type: string): number[] {
  return (child?.snapshotEvents() ?? []).filter((e) => e.type === type).map((e) => e.time);
}

describe('recordCompressionSession：压缩会话记录落盘', () => {
  it('重压缩目标写入标题与父会话目录，普通压缩标题保持原样', async () => {
    const retryTarget = { provider: 'alt', model: 'vendor/big-1' };
    expect(compressionRecordLabel('observe', 3, true, retryTarget)).toBe(
      'OM 压缩会话记录（观察 · 3 轮 · 重压缩 alt/vendor/big-1）',
    );
    expect(compressionRecordLabel('reflect', 1, false, retryTarget)).toBe(
      'OM 压缩失败日志（反思 · 1 轮 · 重压缩 alt/vendor/big-1）',
    );
    expect(compressionRecordLabel('observe', 3, true)).toBe('OM 压缩会话记录（观察 · 3 轮）');
    const ctx = makeCtx();
    const parent = makeSession({ events: twoCallFlow() });
    await recordCompressionSession(ctx, parent, {
      phase: 'observe',
      messages: loopMessages(),
      stats: makeStats([{ durationMs: 100 }]),
      success: true,
      debug: false,
      retryTarget,
    });
    const label = compressionRecordLabel('observe', 1, true, retryTarget);
    expect(parent.snapshotEvents().at(-1)).toMatchObject({
      type: 'subagent/catalog',
      data: { label },
    });
    const descriptor = ctx._createdSessions[0]?.session
      .snapshotEvents()
      .find((e) => e.type === 'subagent/descriptor');
    expect(descriptor?.data).toMatchObject({ label });
  });

  it('header 元数据：origin subagent + parentSession + delegationDepth = 父 + 1 + cwd 继承', async () => {
    const ctx = makeCtx();
    const parent = makeSession({
      events: twoCallFlow(),
      header: { cwd: 'D:\\work\\proj', delegationDepth: 2 },
    });
    const id = await recordCompressionSession(ctx, parent, {
      phase: 'observe',
      messages: loopMessages(),
      stats: makeStats([{ durationMs: 100, usage: { inputTokens: 10, outputTokens: 5 } }]),
      success: true,
      debug: false,
    });
    expect(id).toBe(ctx._createdSessions[0]?.id);
    const created = ctx._createdSessions[0];
    expect(created).toBeDefined();
    const meta = (created?.options as { meta?: Record<string, unknown> } | undefined)?.meta;
    expect(meta).toEqual({
      cwd: 'D:\\work\\proj',
      parentSession: parent.id,
      origin: 'subagent',
      delegationDepth: 3,
    });
    const catalog = parent.snapshotEvents().at(-1);
    expect(parent.snapshotEvents()).toHaveLength(twoCallFlow().length + 1);
    expect(catalog).toMatchObject({
      type: 'subagent/catalog',
      data: {
        version: 0,
        childId: id,
        childCreatedAt: created?.session.header.createdAt,
        mode: 'one-shot',
        label: compressionRecordLabel('observe', 1, true),
      },
    });
    // 父会话目录写入宿主活跃会话后进入持久化屏障。
    expect(ctx._flushedSessions).toEqual([parent]);
    const write = ctx._persistenceWrites[0];
    expect(write?.header).toEqual(created?.session.header);
    expect(write?.events).toEqual(created?.session.snapshotEvents());
    expect(write?.events.map((event) => event.seq)).toEqual(
      created?.session.snapshotEvents().map((event) => event.seq),
    );
    expect(write?.flushes).toBe(1);
    expect(write?.closes).toBe(1);
  });

  it('成功：descriptor 载荷与循环消息组原样落盘，事件序列仅含循环消息', async () => {
    const ctx = makeCtx();
    const parent = makeSession({ events: twoCallFlow() });
    const id = await recordCompressionSession(ctx, parent, {
      phase: 'reflect',
      messages: loopMessages(),
      stats: makeStats([
        { durationMs: 100, usage: { inputTokens: 10, outputTokens: 5 } },
        { durationMs: 200, usage: { inputTokens: 20, outputTokens: 8 } },
      ]),
      success: true,
      debug: false,
    });
    expect(id).toBe(ctx._createdSessions[0]?.id);
    const child = ctx._createdSessions[0]?.session;
    expect(child).toBeDefined();
    const descriptor = child?.snapshotEvents().find((e) => e.type === 'subagent/descriptor');
    expect(descriptor?.data).toEqual({
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: 'one-shot',
      provider: COMPACTION_LOG_PROVIDER,
      // label 轮数取自统计的逐轮数组长度
      label: compressionRecordLabel('reflect', 2, true),
    });
    expect(compressionRecordLabel('reflect', 2, true)).toContain('会话记录');
    expect(compressionRecordLabel('observe', 1, false)).toContain('失败日志');
    // 消息组原样：user 指令 + assistant（含 tool-call 块）+ tool 结果消息
    const { user, assistant, tool } = child
      ? messageEvents(child)
      : { user: [], assistant: [], tool: [] };
    expect(user).toHaveLength(1);
    expect(assistant).toHaveLength(1);
    expect(tool).toHaveLength(1);
    expect(JSON.stringify(assistant)).toContain('getHistory');
    // tool 结果落盘为 tool/result 事件：载荷携带 turn/step 与完整的 tool 角色消息
    const toolData = (tool[0] as { data?: unknown } | undefined)?.data as
      | { turn?: number; step?: number; message?: Record<string, unknown> }
      | undefined;
    expect(toolData?.turn).toBe(1);
    expect(toolData?.step).toBe(1);
    expect(toolData?.message?.role).toBe('tool');
    expect(toolData?.message?.toolCallId).toBe('c1');
    expect(JSON.stringify(toolData?.message)).toContain('历史条目');
    expect(child?.snapshotEvents().map((event) => event.type)).toEqual([
      'subagent/descriptor',
      'turn/start',
      'user/message',
      'step/start',
      'assistant/message',
      'tool/call',
      'tool/result',
      'step/end',
      'turn/end',
    ]);
  });

  it('时间线重建：turn/step 边界与 assistant 完成时刻取自循环统计，时间单调不减', async () => {
    const ctx = makeCtx();
    await recordCompressionSession(ctx, makeSession(), {
      phase: 'observe',
      messages: twoRoundMessages(),
      stats: makeStats([
        { durationMs: 100, usage: { inputTokens: 10, outputTokens: 5 } },
        { durationMs: 200, usage: { inputTokens: 20, outputTokens: 8 } },
      ]),
      success: true,
      debug: false,
    });
    const child = ctx._createdSessions[0]?.session;
    // turn 边界取自循环起止（而非落盘时刻）
    expect(times(child, 'turn/start')).toEqual([1_000]);
    expect(times(child, 'turn/end')).toEqual([6_000]);
    // 第 k 个 step/start = 第 k 轮 startedAt；assistant/message = startedAt + durationMs
    expect(times(child, 'step/start')).toEqual([1_000, 1_100]);
    expect(times(child, 'assistant/message')).toEqual([1_100, 1_300]);
    // 工具调用与结果与其所属 assistant 同刻（内存工具瞬时执行）
    expect(times(child, 'tool/call')).toEqual([1_100, 1_300]);
    expect(times(child, 'tool/result')).toEqual([1_100, 1_300]);
    // 任务指令与 turn/start 同刻
    expect(times(child, 'user/message')).toEqual([1_000]);
    // 全日志时间单调不减（宿主原生 UI 据此派生各处时长）
    const all = (child?.snapshotEvents() ?? []).map((e) => e.time);
    expect(all).toEqual([...all].sort((a, b) => a - b));
  });

  it('轮次统计少于 assistant 数时回落：缺统计的 assistant 止于循环结束时刻', async () => {
    const ctx = makeCtx();
    await recordCompressionSession(ctx, makeSession(), {
      phase: 'observe',
      messages: twoRoundMessages(),
      stats: makeStats([{ durationMs: 100, usage: { inputTokens: 10, outputTokens: 5 } }]),
      success: false,
      debug: false,
    });
    const child = ctx._createdSessions[0]?.session;
    // 第二个 assistant 无对应轮次：起于上一轮结束，止于循环结束
    expect(times(child, 'step/start')).toEqual([1_000, 1_100]);
    expect(times(child, 'assistant/message')).toEqual([1_100, 6_000]);
    expect(times(child, 'tool/result')).toEqual([1_100, 6_000]);
    expect(times(child, 'turn/end')).toEqual([6_000]);
    const assistant = (child?.snapshotEvents() ?? []).filter((e) => e.type === 'assistant/message');
    expect('usage' in ((assistant[1]?.data ?? {}) as Record<string, unknown>)).toBe(false);
    const all = (child?.snapshotEvents() ?? []).map((e) => e.time);
    expect(all).toEqual([...all].sort((a, b) => a - b));
  });

  it('轮间提醒消息与上一轮 assistant 同刻', async () => {
    const ctx = makeCtx();
    const [instruction, , , second, secondTool] = twoRoundMessages();
    const textOnly = {
      id: 'm2' as never,
      role: 'assistant',
      content: [{ type: 'text', text: '仅文本' }],
      source: { kind: 'model', provider: 'test', model: 'test-model' },
    } as unknown as Message;
    const nudge = {
      id: 'm3' as never,
      role: 'user',
      content: [textBlock('请调用工具')],
      source: { kind: PLUGIN_SOURCE_KIND },
    } as unknown as Message;
    await recordCompressionSession(ctx, makeSession(), {
      phase: 'observe',
      messages: [instruction, textOnly, nudge, second, secondTool].filter(
        (m): m is Message => m !== undefined,
      ),
      stats: makeStats([{ durationMs: 100 }, { durationMs: 200 }]),
      success: true,
      debug: false,
    });
    const child = ctx._createdSessions[0]?.session;
    expect(times(child, 'user/message')).toEqual([1_000, 1_100]);
    expect(times(child, 'step/start')).toEqual([1_000, 1_100]);
    expect(times(child, 'assistant/message')).toEqual([1_100, 1_300]);
  });

  it('逐轮 usage 附加到对应 assistant/message；缺 usage 的轮次不写该字段', async () => {
    const ctx = makeCtx();
    await recordCompressionSession(ctx, makeSession(), {
      phase: 'observe',
      messages: twoRoundMessages(),
      stats: makeStats([
        { durationMs: 100, usage: { inputTokens: 10, outputTokens: 5 } },
        { durationMs: 200 },
      ]),
      success: true,
      debug: false,
    });
    const child = ctx._createdSessions[0]?.session;
    const assistant = (child?.snapshotEvents() ?? []).filter((e) => e.type === 'assistant/message');
    expect(assistant).toHaveLength(2);
    const usageOf = (event: SessionEvent | undefined): TokenUsage | undefined =>
      (event?.data as { usage?: TokenUsage } | undefined)?.usage;
    expect(usageOf(assistant[0])).toEqual({ inputTokens: 10, outputTokens: 5 });
    // 第二轮无 usage：字段缺省（不写 undefined，保持 seed 可无损序列化）
    expect(usageOf(assistant[1])).toBeUndefined();
    expect('usage' in ((assistant[1]?.data ?? {}) as Record<string, unknown>)).toBe(false);
  });

  it('未执行的工具调用补齐宿主可读取的 TOOL_NOT_STARTED 结果', async () => {
    const ctx = makeCtx();
    const id = await recordCompressionSession(ctx, makeSession(), {
      phase: 'observe',
      messages: loopMessages().slice(0, 2),
      stats: makeStats([{ durationMs: 50 }]),
      success: false,
      debug: false,
    });
    expect(id).toBeDefined();
    const events = ctx._createdSessions[0]?.session.snapshotEvents() ?? [];
    expect(events.find((event) => event.type === 'tool/result')).toMatchObject({
      data: {
        error: { code: 'TOOL_NOT_STARTED' },
        message: { toolCallId: 'c1', isError: true },
      },
    });
    expect(events.at(-1)?.type).toBe('turn/end');
  });

  it('失败：label 为失败日志，消息组同样原样落盘', async () => {
    const ctx = makeCtx();
    const parent = makeSession();
    await recordCompressionSession(ctx, parent, {
      phase: 'observe',
      messages: loopMessages(),
      stats: makeStats([{ durationMs: 100 }]),
      success: false,
      debug: false,
    });
    const child = ctx._createdSessions[0]?.session;
    const descriptor = child?.snapshotEvents().find((e) => e.type === 'subagent/descriptor');
    expect((descriptor?.data as { label?: string })?.label).toContain('失败日志');
    expect(parent.snapshotEvents().at(-1)).toMatchObject({
      type: 'subagent/catalog',
      data: {
        childId: child?.id,
        label: compressionRecordLabel('observe', 1, false),
      },
    });
  });

  it('落盘自身失败：create 抛错时仅 warn 并返回 undefined', async () => {
    const ctx = makeCtx();
    (ctx.sessions as { create: unknown }).create = () => {
      throw new Error('sessions down');
    };
    const id = await recordCompressionSession(ctx, makeSession(), {
      phase: 'observe',
      messages: loopMessages(),
      stats: makeStats([{ durationMs: 100 }]),
      success: false,
      debug: false,
    });
    expect(id).toBeUndefined();
    expect(
      ctx._loggerCalls.some((c) => c.level === 'warn' && c.args.join('').includes('落盘失败')),
    ).toBe(true);
  });

  it('没有持久化服务时不报告已落盘子会话', async () => {
    const ctx = makeCtx();
    const originalGet = (ctx as { get: (name: string) => object | undefined }).get.bind(ctx);
    (ctx as { get: (name: string) => object | undefined }).get = (name) =>
      name === 'sessionPersistence' ? undefined : originalGet(name);
    const id = await recordCompressionSession(ctx, makeSession(), {
      phase: 'observe',
      messages: loopMessages(),
      stats: makeStats([]),
      success: true,
      debug: false,
    });
    expect(id).toBeUndefined();
    expect(ctx._loggerCalls.some((entry) => entry.level === 'warn')).toBe(true);
  });

  it('flush 抛错：仅 warn，不返回未落盘子会话 id', async () => {
    const ctx = makeCtx();
    const originalCreate = ctx._mockSessionPersistence.create;
    ctx._mockSessionPersistence.create = async (header, options) => {
      const write = await originalCreate(header, options);
      return {
        ...write,
        flush: async () => {
          throw new Error('flush down');
        },
      };
    };
    const parent = makeSession();
    const id = await recordCompressionSession(ctx, parent, {
      phase: 'observe',
      messages: loopMessages(),
      stats: makeStats([{ durationMs: 100 }]),
      success: true,
      debug: false,
    });
    expect(id).toBeUndefined();
    expect(parent.snapshotEvents().some((event) => event.type === 'subagent/catalog')).toBe(false);
    expect(ctx._persistenceWrites[0]?.closes).toBe(1);
    expect(
      ctx._loggerCalls.some((c) => c.level === 'warn' && c.args.join('').includes('落盘失败')),
    ).toBe(true);
  });

  it.each(['create', 'append', 'close'] as const)(
    '持久化 %s 失败时警告并且不返回子会话 id',
    async (stage) => {
      const ctx = makeCtx();
      const originalCreate = ctx._mockSessionPersistence.create;
      ctx._mockSessionPersistence.create = async (header, options) => {
        if (stage === 'create') throw new Error('create down');
        const write = await originalCreate(header, options);
        return {
          ...write,
          append: async (events) => {
            if (stage === 'append') throw new Error('append down');
            return write.append(events);
          },
          close: async () => {
            await write.close();
            if (stage === 'close') throw new Error('close down');
          },
        };
      };
      const parent = makeSession();
      const id = await recordCompressionSession(ctx, parent, {
        phase: 'observe',
        messages: loopMessages(),
        stats: makeStats([{ durationMs: 100 }]),
        success: false,
        debug: false,
      });
      expect(id).toBeUndefined();
      expect(parent.snapshotEvents().some((event) => event.type === 'subagent/catalog')).toBe(
        false,
      );
      expect(ctx._persistenceWrites[0]?.closes).toBe(stage === 'create' ? undefined : 1);
      expect(ctx._loggerCalls.some((entry) => entry.level === 'warn')).toBe(true);
    },
  );

  it('新宿主契约：seed 被真实 SessionStore 接受，时间戳原样保留、assistant 携带 stream 与 usage', async () => {
    // 子会话以 seed 事件构造（每个事件携带重建的 time），真实宿主在 seed 边界校验消息
    // 形状与表层元数据，并原样保留 time（append 路径会强制改写为 Date.now()，测不出）。
    // assistant/message 载荷必填 stream（诊断记录不保留逐 chunk 流，落盘为空数组）并附
    // 逐轮 usage；tool/result 载荷的 message 为独立 tool 角色（顶层 toolCallId/isError）。
    const host = new Context();
    await host.plugin(SessionStore);
    const ctx = makeCtx();
    let realChild: Session | undefined;
    (ctx.sessions as { create: unknown }).create = (id: unknown, options: unknown) => {
      realChild = host.sessions.create(
        id as Parameters<typeof host.sessions.create>[0],
        options as never,
      ) as Session;
      return realChild;
    };
    const id = await recordCompressionSession(ctx, makeSession(), {
      phase: 'observe',
      messages: loopMessages(),
      stats: makeStats([{ durationMs: 100, usage: { inputTokens: 10, outputTokens: 5 } }]),
      success: true,
      debug: false,
    });
    // seed 若被宿主拒绝，create 抛错被吞、id 为 undefined：此断言即失败
    expect(id).toBeDefined();
    expect(id).toBe(realChild?.id);
    const events = realChild?.snapshotEvents() ?? [];
    const assistant = events.filter((e) => e.type === 'assistant/message');
    expect(assistant).toHaveLength(1);
    expect((assistant[0]?.data as { stream?: unknown })?.stream).toEqual([]);
    expect((assistant[0]?.data as { usage?: TokenUsage })?.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
    });
    // 任务指令落盘为唯一 user/message
    expect(events.filter((e) => e.type === 'user/message')).toHaveLength(1);
    const tool = events.filter((e) => e.type === 'tool/result');
    expect(tool).toHaveLength(1);
    const toolMessage = (tool[0]?.data as SessionEventMap['tool/result'] | undefined)?.message;
    expect(toolMessage?.role).toBe('tool');
    expect(toolMessage?.toolCallId).toBe('c1');
    expect(toolMessage?.isError).toBe(false);
    // 真实宿主保留 seed 的重建时间戳：turn/start 取自循环统计而非落盘时刻
    expect(events.find((e) => e.type === 'turn/start')?.time).toBe(1_000);
    expect(events.find((e) => e.type === 'turn/end')?.time).toBe(6_000);
  });
});
