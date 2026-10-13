// 进度提醒单元测试：验证提醒消息的 source、文本，以及“总是存在”的补发判断
// （表层已有 / 本 step 已带上 / 被压缩遮蔽 / 文本过期）。
import { describe, expect, it } from 'vitest';
import { isPluginOwnedSource } from '../src/constants.ts';
import {
  ensureProgressReminder,
  PROGRESS_REMINDER_SOURCE_KIND,
  progressReminderMessage,
} from '../src/progress-reminder.ts';
import type { UserMessage } from '../src/types.ts';
import { makeMessage, makeSession, textBlock } from './helpers.ts';

/** 把提醒消息作为 user/message 事件放进会话日志。 */
function reminderEvent(text?: string) {
  const message = progressReminderMessage();
  return {
    type: 'user/message',
    seq: 0,
    time: 0,
    surfaceOp: 'append',
    data: text === undefined ? message : { ...message, content: [textBlock(text)] },
  } as never;
}

/** 提取消息列表中的提醒消息。 */
function reminders(messages: readonly UserMessage[]): UserMessage[] {
  return messages.filter((message) => message.source.kind === PROGRESS_REMINDER_SOURCE_KIND);
}

describe('progressReminderMessage', () => {
  it('是带专属 source 的 user 消息，文本被 system-reminder 包裹', () => {
    const message = progressReminderMessage();
    const text = message.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
    expect(message.role).toBe('user');
    expect(message.source.kind).toBe(PROGRESS_REMINDER_SOURCE_KIND);
    expect(text.startsWith('<system-reminder>')).toBe(true);
    expect(text.endsWith('</system-reminder>')).toBe(true);
  });

  it('提醒要求边做边说，而不是只在任务结束时说明', () => {
    const message = progressReminderMessage();
    const text = message.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
    expect(text).toMatch(/not (only|just|wait)[^.]*(finish|end|complete)/i);
    expect(text).toMatch(/plan/i);
  });

  it('不被识别为插件自产压缩日志消息，而是记为系统消息参与完整消息索引', () => {
    expect(isPluginOwnedSource(progressReminderMessage().source)).toBe(false);
  });

  it('每次构造使用新的消息 id', () => {
    expect(progressReminderMessage().id).not.toBe(progressReminderMessage().id);
  });
});

describe('ensureProgressReminder', () => {
  const claimed = makeMessage({ content: [textBlock('请做点事')] }) as unknown as UserMessage;

  it('表层与本 step 都没有提醒时追加到末尾，并保留原有消息顺序', () => {
    const session = makeSession({ events: [] });
    const result = ensureProgressReminder(session, [claimed]);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(claimed);
    expect(result[1]?.source.kind).toBe(PROGRESS_REMINDER_SOURCE_KIND);
  });

  it('本 step 已带上提醒时不再追加', () => {
    const session = makeSession({ events: [] });
    const once = ensureProgressReminder(session, [claimed]);
    const twice = ensureProgressReminder(session, once);
    expect(reminders(twice)).toHaveLength(1);
  });

  it('表层已有相同文本的提醒时不追加', () => {
    const session = makeSession({ events: [reminderEvent()] });
    expect(ensureProgressReminder(session, [claimed])).toEqual([claimed]);
  });

  it('提醒已被压缩遮蔽（在日志中但不在表层）时重新追加', () => {
    const session = makeSession({ events: [reminderEvent()], surfaceNodes: [] });
    expect(reminders(ensureProgressReminder(session, [claimed]))).toHaveLength(1);
  });

  it('表层只有过期文本的提醒时补发当前文本', () => {
    const session = makeSession({
      events: [reminderEvent('<system-reminder>旧</system-reminder>')],
    });
    const result = ensureProgressReminder(session, [claimed]);
    const added = reminders(result);
    expect(added).toHaveLength(1);
    expect(added[0]?.content).toEqual(progressReminderMessage().content);
  });

  it('不修改传入的消息数组', () => {
    const session = makeSession({ events: [] });
    const input = [claimed];
    ensureProgressReminder(session, input);
    expect(input).toEqual([claimed]);
  });
});
