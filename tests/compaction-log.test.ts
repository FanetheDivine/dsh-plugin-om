// compaction-log.ts 单元测试：压缩会话记录落盘 recordCompressionSession——header
// 元数据（origin/parentSession/delegationDepth/cwd 继承）、subagent/descriptor 载荷
// （version/mode/provider/label 成功与失败形态）、循环消息组原样结构与顺序（无额外
// 消息）、flush 调用、落盘异常被吞（create/flush 失败仅 warn 不抛错）。

import { SUBAGENT_DESCRIPTOR_VERSION } from '@deepseek-ai/dsh-subagent';
import { describe, expect, it } from 'vitest';

import {
  COMPACTION_LOG_PROVIDER,
  compressionRecordLabel,
  recordCompressionSession,
} from '../src/compaction-log.ts';
import { PLUGIN_LABEL } from '../src/constants.ts';
import type { Message, Session } from '../src/types.ts';
import { makeCtx, makeSession, textBlock, twoCallFlow } from './helpers.ts';

const TARGET = { provider: 'test', model: 'test-model' };

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
    user: child.events.filter((e) => e.type === 'user/message'),
    assistant: child.events.filter((e) => e.type === 'assistant/message'),
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
      rounds: 1,
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
    expect(parent.events).toHaveLength(twoCallFlow().length);
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
      rounds: 2,
      success: true,
      debug: false,
    });
    expect(id).toBe(ctx._createdSessions[0]?.id);
    const child = ctx._createdSessions[0]?.session;
    expect(child).toBeDefined();
    const descriptor = child?.events.find((e) => e.type === 'subagent/descriptor');
    expect(descriptor?.data).toEqual({
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: 'one-shot',
      provider: COMPACTION_LOG_PROVIDER,
      label: compressionRecordLabel('reflect', 2, true),
    });
    expect(compressionRecordLabel('reflect', 2, true)).toContain('会话记录');
    expect(compressionRecordLabel('observe', 1, false)).toContain('失败日志');
    // 消息组原样：user 指令 + assistant（含 tool-call 块）+ tool-result，共 3 条
    const { user, assistant } = child ? messageEvents(child) : { user: [], assistant: [] };
    expect(user).toHaveLength(2);
    expect(assistant).toHaveLength(1);
    expect(JSON.stringify(assistant)).toContain('getHistory');
    expect(JSON.stringify(user[1])).toContain('tool-result');
  });

  it('失败：label 为失败日志，消息组同样原样落盘', async () => {
    const ctx = makeCtx();
    const parent = makeSession();
    await recordCompressionSession(ctx, parent, {
      phase: 'observe',
      target: TARGET,
      messages: loopMessages(),
      rounds: 1,
      success: false,
      debug: false,
    });
    const child = ctx._createdSessions[0]?.session;
    const descriptor = child?.events.find((e) => e.type === 'subagent/descriptor');
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
      rounds: 1,
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
      rounds: 1,
      success: true,
      debug: false,
    });
    expect(id).toBe(ctx._createdSessions[0]?.id);
    expect(
      ctx._loggerCalls.some((c) => c.level === 'warn' && c.args.join('').includes('flush 失败')),
    ).toBe(true);
  });
});
