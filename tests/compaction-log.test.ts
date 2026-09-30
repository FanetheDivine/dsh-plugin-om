// compaction-log.ts 单元测试：压缩会话记录落盘 recordCompressionSession——header
// 元数据（origin/parentSession/delegationDepth/cwd 继承）、subagent/descriptor 载荷
// （version/mode/provider/label 成功与失败形态）、循环消息组原样结构与顺序、末尾
// 统计消息（逐轮耗时与 usage、usage 合计）、flush 调用、落盘异常被吞（create/flush
// 失败仅 warn 不抛错）。

import { Context } from '@deepseek-ai/cordis';
import { SessionStore } from '@deepseek-ai/dsh-session';
import { SUBAGENT_DESCRIPTOR_VERSION } from '@deepseek-ai/dsh-subagent';
import { describe, expect, it } from 'vitest';

import {
  COMPACTION_LOG_PROVIDER,
  compressionRecordLabel,
  formatCompressionStats,
  recordCompressionSession,
} from '../src/compaction-log.ts';
import type { CompressionStats } from '../src/compress-loop.ts';
import { PLUGIN_SOURCE_KIND } from '../src/constants.ts';
import type { Message, Session } from '../src/types.ts';
import { makeCtx, makeSession, textBlock, twoCallFlow } from './helpers.ts';

const TARGET = { provider: 'test', model: 'test-model' };

/** 构造循环统计：startedAt 固定，逐轮耗时与 usage 可指定。 */
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

/** 构造循环消息组：user 指令 + assistant（tool-call）+ tool 结果消息。 */
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

/** 断言辅助：取子会话事件中的 user/assistant/tool 消息（descriptor 占 seq 0）。 */
function messageEvents(child: Session): { user: unknown[]; assistant: unknown[]; tool: unknown[] } {
  return {
    user: child.snapshotEvents().filter((e) => e.type === 'user/message'),
    assistant: child.snapshotEvents().filter((e) => e.type === 'assistant/message'),
    tool: child.snapshotEvents().filter((e) => e.type === 'tool/result'),
  };
}

describe('recordCompressionSession：压缩会话记录落盘', () => {
  it('header 元数据：origin subagent + parentSession + delegationDepth = 父 + 1 + cwd 继承', async () => {
    const ctx = makeCtx();
    const parent = makeSession({
      events: twoCallFlow(),
      header: { cwd: 'D:\\work\\proj', delegationDepth: 2 },
    });
    const id = await recordCompressionSession(ctx, parent, {
      phase: 'observe',
      target: TARGET,
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

  it('成功：descriptor 载荷与循环消息组原样落盘', async () => {
    const ctx = makeCtx();
    const parent = makeSession({ events: twoCallFlow() });
    const id = await recordCompressionSession(ctx, parent, {
      phase: 'reflect',
      target: TARGET,
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
    // 消息组原样：user 指令 + assistant（含 tool-call 块）+ tool 结果消息，末尾再追加
    // 一条统计消息（user 2 + assistant 1 + tool 1）
    const { user, assistant, tool } = child
      ? messageEvents(child)
      : { user: [], assistant: [], tool: [] };
    expect(user).toHaveLength(2);
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
      'user/message',
      'turn/end',
    ]);
  });

  it('未执行的工具调用补齐宿主可读取的 TOOL_NOT_STARTED 结果', async () => {
    const ctx = makeCtx();
    const id = await recordCompressionSession(ctx, makeSession(), {
      phase: 'observe',
      target: TARGET,
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

  it('末尾统计消息：插件来源，含起止时间、总耗时、逐轮明细与 usage 合计', async () => {
    const ctx = makeCtx();
    const parent = makeSession();
    await recordCompressionSession(ctx, parent, {
      phase: 'observe',
      target: TARGET,
      messages: loopMessages(),
      stats: makeStats([
        { durationMs: 100, usage: { inputTokens: 10, outputTokens: 5 } },
        { durationMs: 200 },
      ]),
      success: true,
      debug: false,
    });
    const child = ctx._createdSessions[0]?.session;
    const userEvents = child?.snapshotEvents().filter((e) => e.type === 'user/message') ?? [];
    const statsEvent = userEvents[userEvents.length - 1];
    if (statsEvent === undefined) throw new Error('缺统计消息');
    const statsData = statsEvent.data as {
      content?: ReadonlyArray<{ text?: string }>;
      source?: { kind?: string };
    };
    const text = (statsData.content ?? []).map((block) => block.text ?? '').join('');
    expect(text).toContain('总耗时：5000 ms');
    expect(text).toContain('请求轮数：2');
    expect(text).toContain('第 1 轮：耗时 100 ms');
    expect(text).toContain('input 10 / output 5');
    expect(text).toContain('第 2 轮：耗时 200 ms');
    expect(text).toContain('usage 合计：input 10 / output 5');
    // 统计消息为插件自产来源（producer-owned kind），与压缩指令消息一致
    expect(statsData.source?.kind).toBe(PLUGIN_SOURCE_KIND);
  });

  it('formatCompressionStats：全部轮次无 usage 时不输出 usage 合计行', () => {
    const text = formatCompressionStats('observe', false, makeStats([{ durationMs: 100 }]));
    expect(text).toContain('结果：失败');
    expect(text).toContain('请求轮数：1');
    expect(text).not.toContain('usage 合计');
  });

  it('失败：label 为失败日志，消息组同样原样落盘', async () => {
    const ctx = makeCtx();
    const parent = makeSession();
    await recordCompressionSession(ctx, parent, {
      phase: 'observe',
      target: TARGET,
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
      target: TARGET,
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
      target: TARGET,
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
      target: TARGET,
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
        target: TARGET,
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

  it('新宿主契约：assistant/message 携带 stream、tool/result 携带 tool 角色消息，真实 Session.append 接受载荷', async () => {
    // assistant/message 载荷必填 stream（模型流的紧凑记录），tool/result 载荷的 message
    // 为独立 tool 角色（顶层 toolCallId/isError）；诊断子会话不保留逐 chunk 流，落盘为
    // 空数组。create 桥接到真实 SessionStore 会话，验证载荷满足真实宿主的追加校验
    // （mock 会话不做载荷校验，测不出违约）。
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
      target: TARGET,
      messages: loopMessages(),
      stats: makeStats([{ durationMs: 100, usage: { inputTokens: 10, outputTokens: 5 } }]),
      success: true,
      debug: false,
    });
    expect(id).toBe(realChild?.id);
    const assistant =
      realChild?.snapshotEvents().filter((e) => e.type === 'assistant/message') ?? [];
    expect(assistant).toHaveLength(1);
    // 诊断记录不保留逐 chunk 流：stream 恒为空数组
    expect((assistant[0]?.data as { stream?: unknown } | undefined)?.stream).toEqual([]);
    // 落盘未被宿主拒绝：user 指令与统计消息、tool 结果同样在真实会话中
    expect(realChild?.snapshotEvents().filter((e) => e.type === 'user/message')).toHaveLength(2);
    const tool = realChild?.snapshotEvents().filter((e) => e.type === 'tool/result') ?? [];
    expect(tool).toHaveLength(1);
    const toolMessage = (tool[0]?.data as { message?: Record<string, unknown> } | undefined)
      ?.message;
    expect(toolMessage?.role).toBe('tool');
    expect(toolMessage?.toolCallId).toBe('c1');
    expect(toolMessage?.isError).toBe(false);
  });
});
