// om 私有事件（om-event.ts）单元测试：写入为 ignorable plugin record，
// om/observe-summary 载荷往返、可选字段缺省、严格校验拒绝与类别过滤。
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { describe, expect, it } from 'vitest';
import { findOmEvents } from '../src/om-event.ts';
import { appendOmEvent } from '../src/om-event-append.ts';
import type { SessionEvent } from '../src/types.ts';
import { makeOmEvent, makeSession } from './helpers.ts';

const fullData = {
  pendingSeq: 4,
  report: '<history>摘要</history>',
  provider: 'deepseek',
  model: 'deepseek-chat',
  startedAt: 1000,
  completedAt: 5000,
  durationMs: 4000,
  recordSessionId: 'om-compaction-log-x',
  usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
  reasoningEffort: 'high',
};

describe('om/observe-summary 记录', () => {
  it('写入为 ignorable plugin record', () => {
    const session = makeSession();
    appendOmEvent(session, 'om/observe-pending', { triggerMessageIndex: 2 });
    const [event] = session.snapshotEvents();
    expect(event).toMatchObject({
      type: 'plugin:dsh-plugin-om/observe-pending',
      data: { triggerMessageIndex: 2 },
      ignorable: true,
    });
  });

  it('旧 feedback/record 信封与未标 ignorable 的同名事件不识别', () => {
    const legacy = {
      type: 'feedback/record',
      data: {
        text: `om:1:${JSON.stringify({ kind: 'om/observe-pending', triggerMessageIndex: 2 })}`,
      },
    } as unknown as SessionEvent;
    const notIgnorable = {
      type: 'plugin:dsh-plugin-om/observe-pending',
      data: { triggerMessageIndex: 2 },
    } as unknown as SessionEvent;
    const session = makeSession({ events: [legacy, notIgnorable] });
    expect(findOmEvents(session)).toEqual([]);
  });

  it('完整载荷往返（findOmEvents 按类别返回数据与 seq）', () => {
    const session = makeSession();
    const seq = appendOmEvent(session, 'om/observe-summary', fullData);
    expect(seq).toBe(0);
    expect(findOmEvents(session, 'om/observe-summary')).toEqual([
      { kind: 'om/observe-summary', data: fullData, seq: 0 },
    ]);
  });

  it('可选字段可缺省（往返结果不携带缺省键）', () => {
    const minimal = {
      pendingSeq: 7,
      report: 'r',
      provider: 'p',
      model: 'm',
      startedAt: 1,
      completedAt: 2,
      durationMs: 1,
    };
    const session = makeSession();
    appendOmEvent(session, 'om/observe-summary', minimal);
    const [event] = findOmEvents(session, 'om/observe-summary');
    expect(event?.data).toEqual(minimal);
  });

  it('非法载荷被拒绝（readOmEvent 返回 undefined，不进 findOmEvents）', () => {
    const invalid: Record<string, unknown>[] = [
      { ...fullData, report: 123 },
      { ...fullData, pendingSeq: 1.5 },
      { ...fullData, provider: 1 },
      { ...fullData, startedAt: 'x' },
      { ...fullData, durationMs: Number.NaN },
      { ...fullData, recordSessionId: 42 },
      { ...fullData, reasoningEffort: true },
      { ...fullData, usage: { outputTokens: 1 } },
      { ...fullData, usage: { inputTokens: 1, outputTokens: 2, totalTokens: 'x' } },
      { ...fullData, usage: 'lots' },
    ];
    for (const data of invalid) {
      const session = makeSession({ events: [makeOmEvent('om/observe-summary', data)] });
      expect(findOmEvents(session, 'om/observe-summary')).toEqual([]);
    }
  });

  it('findOmEvents 类别过滤只返回 observe-summary，缺省返回全部', () => {
    const session = makeSession();
    appendOmEvent(session, 'om/observe-pending', { triggerMessageIndex: 2 });
    appendOmEvent(session, 'om/observe-summary', fullData);
    expect(findOmEvents(session, 'om/observe-summary')).toHaveLength(1);
    expect(findOmEvents(session)).toHaveLength(2);
  });
});

describe('真实 Session 写读往返', () => {
  it('appendOmEvent 经宿主 appendPluginRecord 落日志，findOmEvents 读回，且不进 surface', () => {
    const session = Session.create(SessionId('om-event-real'));
    const before = session.snapshotEvents().length;
    const seq = appendOmEvent(session, 'om/warning', { problem: 'p', message: 'm' });
    expect(seq).toBe(before);
    const event = session.snapshotEvents()[seq];
    expect(event).toMatchObject({ type: 'plugin:dsh-plugin-om/warning', ignorable: true });
    expect(event).not.toHaveProperty('surfaceOp');
    expect(findOmEvents(session, 'om/warning')).toEqual([
      { kind: 'om/warning', data: { problem: 'p', message: 'm' }, seq },
    ]);
  });
});
