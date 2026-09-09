// compaction-log.ts 单元测试：压缩会话记录落盘 recordCompressionSession——header
// 元数据（origin/parentSession/delegationDepth/cwd 继承）、subagent/descriptor 载荷
// （version/mode/provider/label 成功与失败形态）、循环消息组原样结构与顺序、末尾
// 统计消息（逐轮耗时与 usage、usage 合计）、flush 调用、落盘异常被吞（create/flush
// 失败仅 warn 不抛错）。

import { SUBAGENT_DESCRIPTOR_VERSION } from '@deepseek-ai/dsh-subagent';
import { describe, expect, it } from 'vitest';

import {
  COMPACTION_LOG_PROVIDER,
  compressionRecordLabel,
  formatCompressionStats,
  recordCompressionSession,
} from '../src/compaction-log.ts';
import type { CompressionStats } from '../src/compress-loop.ts';
import { PLUGIN_LABEL } from '../src/constants.ts';
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

/** 构造循环消息组：user 指令 + assistant（tool-call）+ tool-result。 */
function loopMessages(): Message[] {
  return [
    {
      id: 'm1' as never,
      role: 'user',
      content: [textBlock('压缩指令')],
      source: { kind: 'plugin', plugin: PLUGIN_LABEL },
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
      role: 'user',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'c1' as never,
          content: [textBlock('历史条目')],
        },
      ],
      source: { kind: 'tool', callId: 'c1' as never },
    } as unknown as Message,
  ];
}

/** 断言辅助：取子会话事件中的 user/assistant 消息（descriptor 占 seq 0）。 */
function messageEvents(child: Session): { user: unknown[]; assistant: unknown[] } {
  return {
    user: child.snapshotEvents().filter((e) => e.type === 'user/message'),
    assistant: child.snapshotEvents().filter((e) => e.type === 'assistant/message'),
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
    // 主会话未被改动（落盘只创建子会话，不追加任何事件）
    expect(parent.snapshotEvents()).toHaveLength(twoCallFlow().length);
    // flush 已对子会话执行
    expect(ctx._flushedSessions).toHaveLength(1);
    expect(ctx._flushedSessions[0]?.id).toBe(created?.session.id);
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
    // 消息组原样：user 指令 + assistant（含 tool-call 块）+ tool-result，末尾再追加
    // 一条统计消息，共 4 条（user 3 + assistant 1）
    const { user, assistant } = child ? messageEvents(child) : { user: [], assistant: [] };
    expect(user).toHaveLength(3);
    expect(assistant).toHaveLength(1);
    expect(JSON.stringify(assistant)).toContain('getHistory');
    expect(JSON.stringify(user[1])).toContain('tool-result');
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
      content?: Array<{ text?: string }>;
      source?: { kind?: string; plugin?: string };
    };
    const text = (statsData.content ?? []).map((block) => block.text ?? '').join('');
    expect(text).toContain('总耗时：5000 ms');
    expect(text).toContain('请求轮数：2');
    expect(text).toContain('第 1 轮：耗时 100 ms');
    expect(text).toContain('input 10 / output 5');
    expect(text).toContain('第 2 轮：耗时 200 ms');
    expect(text).toContain('usage 合计：input 10 / output 5');
    // 统计消息为插件来源，与压缩指令消息区分
    expect(statsData.source).toEqual({ kind: 'plugin', plugin: PLUGIN_LABEL });
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

  it('flush 抛错：仅 warn，子会话 id 仍返回', async () => {
    const ctx = makeCtx();
    (ctx.sessions as { flush: unknown }).flush = async () => {
      throw new Error('flush down');
    };
    const id = await recordCompressionSession(ctx, makeSession(), {
      phase: 'observe',
      target: TARGET,
      messages: loopMessages(),
      stats: makeStats([{ durationMs: 100 }]),
      success: true,
      debug: false,
    });
    expect(id).toBe(ctx._createdSessions[0]?.id);
    expect(
      ctx._loggerCalls.some((c) => c.level === 'warn' && c.args.join('').includes('flush 失败')),
    ).toBe(true);
  });
});
