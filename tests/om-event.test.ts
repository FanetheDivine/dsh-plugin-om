import { describe, expect, it } from 'vitest';
import { appendOmEvent, findOmEvents, readOmEvent } from '../src/om-event.ts';
import type { Session, SessionEvent } from '../src/types.ts';

function createMockSession(): { session: Session; events: SessionEvent[] } {
  const events: SessionEvent[] = [];
  const session = {
    append(type: string, data: unknown) {
      const event = {
        type,
        seq: events.length,
        time: 1000 + events.length,
        data,
      } as unknown as SessionEvent;
      events.push(event);
      return event;
    },
    snapshotEvents() {
      return [...events];
    },
  } as unknown as Session;
  return { session, events };
}

describe('om-event', () => {
  it('appendOmEvent 直接追加 plugin:dsh-plugin-om:* 事件', () => {
    const { session, events } = createMockSession();
    const seq = appendOmEvent(session, 'plugin:dsh-plugin-om:warning', {
      problem: 'systemPrompt-missing',
      message: '系统提示词服务未挂载',
    });
    expect(seq).toBe(0);
    expect(events[0]).toEqual({
      type: 'plugin:dsh-plugin-om:warning',
      seq: 0,
      time: 1000,
      data: {
        problem: 'systemPrompt-missing',
        message: '系统提示词服务未挂载',
      },
    });
  });

  it('readOmEvent 仅识别 plugin:dsh-plugin-om:* 事件且返回类型化载荷', () => {
    const warningEvent = {
      type: 'plugin:dsh-plugin-om:warning',
      seq: 1,
      time: 1001,
      data: { problem: 'p', message: 'm' },
    } as unknown as SessionEvent;
    expect(readOmEvent(warningEvent)).toEqual({
      kind: 'plugin:dsh-plugin-om:warning',
      data: { problem: 'p', message: 'm' },
      seq: 1,
    });

    const pendingEvent = {
      type: 'plugin:dsh-plugin-om:observe-pending',
      seq: 2,
      time: 1002,
      data: { triggerMessageIndex: 5 },
    } as unknown as SessionEvent;
    expect(readOmEvent(pendingEvent)).toEqual({
      kind: 'plugin:dsh-plugin-om:observe-pending',
      data: { triggerMessageIndex: 5 },
      seq: 2,
    });

    const invalidateEvent = {
      type: 'plugin:dsh-plugin-om:observe-invalidate',
      seq: 3,
      time: 1003,
      data: { pendingSeq: 2 },
    } as unknown as SessionEvent;
    expect(readOmEvent(invalidateEvent)).toEqual({
      kind: 'plugin:dsh-plugin-om:observe-invalidate',
      data: { pendingSeq: 2 },
      seq: 3,
    });
  });

  it('readOmEvent 忽略非本插件事件及 feedback/record', () => {
    expect(readOmEvent(undefined)).toBeUndefined();
    expect(
      readOmEvent({
        type: 'user/message',
        seq: 0,
        time: 1000,
        data: { text: 'hello' },
      } as unknown as SessionEvent),
    ).toBeUndefined();
    expect(
      readOmEvent({
        type: 'feedback/record',
        seq: 1,
        time: 1001,
        data: { text: 'om:1:{"kind":"om/warning"}' },
      } as unknown as SessionEvent),
    ).toBeUndefined();
  });

  it('findOmEvents 支持按类别过滤或返回全部本插件事件', () => {
    const { session } = createMockSession();
    appendOmEvent(session, 'plugin:dsh-plugin-om:observe-pending', { triggerMessageIndex: 3 });
    appendOmEvent(session, 'plugin:dsh-plugin-om:warning', { problem: 'p1', message: 'm1' });
    appendOmEvent(session, 'plugin:dsh-plugin-om:observe-invalidate', { pendingSeq: 0 });

    const all = findOmEvents(session);
    expect(all).toHaveLength(3);
    expect(all.map((e) => e.kind)).toEqual([
      'plugin:dsh-plugin-om:observe-pending',
      'plugin:dsh-plugin-om:warning',
      'plugin:dsh-plugin-om:observe-invalidate',
    ]);

    const warnings = findOmEvents(session, 'plugin:dsh-plugin-om:warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.data).toEqual({ problem: 'p1', message: 'm1' });
  });
});
