// compaction-log.ts 单元测试：压缩调用日志子会话落盘 recordCompactionAttempt——
// header 元数据（origin/parentSession/delegationDepth/cwd 继承）、subagent/descriptor
// 载荷（version/mode/provider/label）、「提示词 + 原始输出」消息组原样结构与顺序
//（无额外消息）、flush 调用、落盘异常被吞（create/flush 失败仅 warn 不抛错）。

import { SUBAGENT_DESCRIPTOR_VERSION } from '@deepseek-ai/dsh-subagent';
import { describe, expect, it } from 'vitest';

import {
  COMPACTION_LOG_PROVIDER,
  compactionLogLabel,
  recordCompactionAttempt,
} from '../src/compaction-log.ts';
import { PLUGIN_LABEL } from '../src/constants.ts';
import type { Session, SessionEvent } from '../src/types.ts';
import { makeCtx, makeSession, twoCallFlow } from './helpers.ts';

const TARGET = { provider: 'test', model: 'test-model' };

/** 断言辅助：取子会话事件中本组尝试的 user/assistant 消息（descriptor 占 seq 0）。 */
function attemptEvents(child: Session): { user: SessionEvent; assistant: SessionEvent } {
  const user = child.events[1];
  const assistant = child.events[2];
  if (!user || !assistant) throw new Error('诊断消息组缺失');
  return { user, assistant } as { user: SessionEvent; assistant: SessionEvent };
}

describe('recordCompactionAttempt：压缩日志子会话落盘', () => {
  it('header 元数据：origin subagent + parentSession + delegationDepth = 父 + 1 + cwd 继承', async () => {
    const ctx = makeCtx();
    const parent = makeSession({
      events: twoCallFlow(),
      header: { cwd: 'D:\\work\\proj', delegationDepth: 2 },
    });
    const id = await recordCompactionAttempt(ctx, parent, {
      phase: 'observe',
      target: TARGET,
      attempt: { prompt: 'P', rawOutput: 'R' },
      attemptNo: 1,
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

  it('descriptor 载荷：version 2 / mode one-shot / provider om-compaction-log / label 含阶段与尝试序号', async () => {
    const ctx = makeCtx();
    const parent = makeSession();
    await recordCompactionAttempt(ctx, parent, {
      phase: 'reflect',
      target: TARGET,
      attempt: { prompt: 'P2', rawOutput: 'R2' },
      attemptNo: 2,
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
    expect(compactionLogLabel('reflect', 2)).toBe('OM会话-反思-重试1');
    expect(compactionLogLabel('observe', 1)).toBe('OM会话-观察');
    expect(compactionLogLabel(undefined, 3)).toBe('OM会话-压缩-重试2');
  });

  it('消息组零加工：单次尝试一对 user/assistant surface 消息，提示词与原始输出原样、无额外内容', async () => {
    const ctx = makeCtx();
    const parent = makeSession();
    const attempt = {
      prompt: '完整提示词\n<history>\n<user_message index="0">旧内容</user_message>\n</history>',
      rawOutput: '模型原始输出（截断）',
    };
    const id = await recordCompactionAttempt(ctx, parent, {
      phase: 'observe',
      target: TARGET,
      attempt,
      attemptNo: 1,
      debug: false,
    });
    const child = ctx._createdSessions[0]?.session;
    expect(child).toBeDefined();
    expect(id).toBe(child?.id);
    // 事件面：descriptor + 1 组消息，共 3 条；surface 仅为 2 条消息
    expect(child?.events).toHaveLength(3);
    expect(child?.surface.nodes).toHaveLength(2);
    const { user, assistant } = attemptEvents(child as Session);
    expect(user.type).toBe('user/message');
    expect((user.data as { content?: Array<{ text?: string }> }).content?.[0]?.text).toBe(
      attempt.prompt,
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
    // 子会话只含单次尝试：step 固定 1（不随 attemptNo 递增）
    expect(data.step).toBe(1);
    expect(data.message.content?.[0]?.text).toBe(attempt.rawOutput);
    expect(data.message.source).toEqual({
      kind: 'model',
      provider: TARGET.provider,
      model: TARGET.model,
    });
    expect((assistant as { surfaceOp?: unknown }).surfaceOp).toBe('append');
  });

  it('ctx.sessions.create 抛错：返回 undefined、仅 warn、不向上抛（不影响压缩流程）', async () => {
    const ctx = makeCtx();
    (ctx as unknown as { sessions: { create: () => never } }).sessions = {
      create: () => {
        throw new Error('store 故障');
      },
    } as never;
    const id = await recordCompactionAttempt(ctx, makeSession(), {
      phase: 'observe',
      target: TARGET,
      attempt: { prompt: 'P', rawOutput: 'R' },
      attemptNo: 2,
      debug: false,
    });
    expect(id).toBeUndefined();
    const warns = ctx._loggerCalls.filter((c) => c.level === 'warn').map((c) => String(c.args[0]));
    expect(
      warns.some(
        (w) => w.includes('压缩日志子会话落盘失败（第 2 次尝试）') && w.includes('store 故障'),
      ),
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
    const id = await recordCompactionAttempt(ctx, makeSession(), {
      phase: 'observe',
      target: TARGET,
      attempt: { prompt: 'P', rawOutput: 'R' },
      attemptNo: 1,
      debug: false,
    });
    expect(id).toBe(ctx._createdSessions[0]?.id);
    const warns = ctx._loggerCalls.filter((c) => c.level === 'warn').map((c) => String(c.args[0]));
    expect(warns.some((w) => w.includes('压缩日志子会话 flush 失败'))).toBe(true);
  });
});
