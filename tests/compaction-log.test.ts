// compaction-log.ts 单元测试：压缩失败诊断子会话落盘 recordCompactionFailure——
// header 元数据（origin/parentSession/delegationDepth/cwd 继承）、subagent/descriptor
// 载荷（version/mode/provider/label）、逐尝试「提示词 + 原始输出」消息组原样结构与
// 顺序（无额外消息）、flush 调用、落盘异常被吞（create/flush 失败仅 warn 不抛错）。

import { SUBAGENT_DESCRIPTOR_VERSION } from '@deepseek-ai/dsh-subagent';
import { describe, expect, it } from 'vitest';

import {
  COMPACTION_LOG_PROVIDER,
  compactionLogLabel,
  recordCompactionFailure,
} from '../src/compaction-log.ts';
import { PLUGIN_LABEL } from '../src/constants.ts';
import type { Session, SessionEvent } from '../src/types.ts';
import { makeCtx, makeSession, twoCallFlow } from './helpers.ts';

const TARGET = { provider: 'test', model: 'test-model' };

/** 断言辅助：取子会话事件中第 i 次尝试的 user/assistant 消息（descriptor 占 seq 0）。 */
function attemptEvents(child: Session, i: number): { user: SessionEvent; assistant: SessionEvent } {
  const base = 1 + i * 2;
  const user = child.events[base];
  const assistant = child.events[base + 1];
  if (!user || !assistant) throw new Error('诊断消息组缺失');
  return { user, assistant } as { user: SessionEvent; assistant: SessionEvent };
}

describe('recordCompactionFailure：诊断子会话落盘', () => {
  it('header 元数据：origin subagent + parentSession + delegationDepth = 父 + 1 + cwd 继承', async () => {
    const ctx = makeCtx();
    const parent = makeSession({
      events: twoCallFlow(),
      header: { cwd: 'D:\\work\\proj', delegationDepth: 2 },
    });
    const id = await recordCompactionFailure(ctx, parent, {
      phase: 'observe',
      target: TARGET,
      attempts: [{ prompt: 'P', rawOutput: 'R' }],
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

  it('descriptor 载荷：version 2 / mode one-shot / provider om-compaction-log / label 含阶段与尝试次数', async () => {
    const ctx = makeCtx();
    const parent = makeSession();
    await recordCompactionFailure(ctx, parent, {
      phase: 'reflect',
      target: TARGET,
      attempts: [
        { prompt: 'P1', rawOutput: 'R1' },
        { prompt: 'P2', rawOutput: 'R2' },
      ],
      debug: false,
    });
    const child = ctx._createdSessions[0]?.session;
    expect(child).toBeDefined();
    const descriptor = child?.events[0];
    expect(descriptor?.type).toBe('subagent/descriptor');
    expect(descriptor?.data).toEqual({
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: 'one-shot',
      provider: COMPACTION_LOG_PROVIDER,
      label: compactionLogLabel('reflect', 2),
    });
    expect(compactionLogLabel('reflect', 2)).toBe('OM 压缩失败日志（反思 · 2 次尝试）');
    expect(compactionLogLabel('observe', 1)).toBe('OM 压缩失败日志（观察 · 1 次尝试）');
  });

  it('消息组零加工：每次尝试一对 user/assistant surface 消息，提示词与原始输出原样、无额外内容', async () => {
    const ctx = makeCtx();
    const parent = makeSession();
    const attempts = [
      {
        prompt:
          '完整提示词一\n<history>\n<user_message index="0">旧内容</user_message>\n</history>',
        rawOutput: '模型输出一（截断）',
      },
      { prompt: '完整提示词二', rawOutput: '' },
    ];
    const id = await recordCompactionFailure(ctx, parent, {
      phase: 'observe',
      target: TARGET,
      attempts,
      debug: false,
    });
    const child = ctx._createdSessions[0]?.session;
    expect(child).toBeDefined();
    expect(id).toBe(child?.id);
    // 事件面：descriptor + 2 组消息，共 5 条；surface 仅为 4 条消息
    expect(child?.events).toHaveLength(5);
    expect(child?.surface.nodes).toHaveLength(4);
    for (let i = 0; i < attempts.length; i += 1) {
      const { user, assistant } = attemptEvents(child as Session, i);
      expect(user.type).toBe('user/message');
      expect((user.data as { content?: Array<{ text?: string }> }).content?.[0]?.text).toBe(
        attempts[i]?.prompt,
      );
      expect((user.data as { source?: { kind?: string; plugin?: string } }).source).toEqual({
        kind: 'plugin',
        plugin: PLUGIN_LABEL,
      });
      expect((user as { surfaceOp?: unknown }).surfaceOp).toBe('append');
      expect(assistant.type).toBe('assistant/message');
      const data = assistant.data as {
        turn: number;
        step: number;
        message: {
          content?: Array<{ text?: string }>;
          source?: { kind?: string; provider?: string; model?: string };
        };
      };
      expect(data.turn).toBe(0);
      expect(data.step).toBe(i + 1);
      expect(data.message.content?.[0]?.text).toBe(attempts[i]?.rawOutput);
      expect(data.message.source).toEqual({
        kind: 'model',
        provider: TARGET.provider,
        model: TARGET.model,
      });
      expect((assistant as { surfaceOp?: unknown }).surfaceOp).toBe('append');
    }
  });

  it('尝试为空（中止在首次请求前）：仅 descriptor 的子会话也落盘并返回 id', async () => {
    const ctx = makeCtx();
    const id = await recordCompactionFailure(ctx, makeSession(), {
      phase: 'reflect',
      target: TARGET,
      attempts: [],
      debug: false,
    });
    const child = ctx._createdSessions[0]?.session;
    expect(child).toBeDefined();
    expect(id).toBe(child?.id);
    expect(child?.events).toHaveLength(1);
    expect(child?.events[0]?.type).toBe('subagent/descriptor');
  });

  it('ctx.sessions.create 抛错：返回 undefined、仅 warn、不向上抛（不影响压缩失败流程）', async () => {
    const ctx = makeCtx();
    (ctx as unknown as { sessions: { create: () => never } }).sessions = {
      create: () => {
        throw new Error('store 故障');
      },
    } as never;
    const id = await recordCompactionFailure(ctx, makeSession(), {
      phase: 'observe',
      target: TARGET,
      attempts: [{ prompt: 'P', rawOutput: 'R' }],
      debug: false,
    });
    expect(id).toBeUndefined();
    const warns = ctx._loggerCalls.filter((c) => c.level === 'warn').map((c) => String(c.args[0]));
    expect(
      warns.some((w) => w.includes('压缩失败诊断子会话落盘失败') && w.includes('store 故障')),
    ).toBe(true);
  });

  it('flush 抛错：子会话已创建仍返回 id，flush 失败仅 warn', async () => {
    const ctx = makeCtx();
    (ctx as unknown as { sessions: { flush: () => Promise<never> } }).sessions = {
      ...(ctx.sessions as unknown as object),
      flush: async () => {
        throw new Error('持久化故障');
      },
    } as never;
    const id = await recordCompactionFailure(ctx, makeSession(), {
      phase: 'observe',
      target: TARGET,
      attempts: [{ prompt: 'P', rawOutput: 'R' }],
      debug: false,
    });
    expect(id).toBe(ctx._createdSessions[0]?.id);
    const warns = ctx._loggerCalls.filter((c) => c.level === 'warn').map((c) => String(c.args[0]));
    expect(warns.some((w) => w.includes('压缩失败诊断子会话 flush 失败'))).toBe(true);
  });
});
