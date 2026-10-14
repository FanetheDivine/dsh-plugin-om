// system-reminder 单元测试：验证进度提醒与完整消息定义提醒的 source、正文、按配置启用，
// 以及“总是存在”的补发判断（表层已有 / 本 step 已带上 / 被压缩遮蔽 / 文本过期 / 两条互不干扰）。
import { describe, expect, it } from 'vitest';
import { COMPLETE_MESSAGE_DEFINITION, isPluginOwnedSource } from '../src/constants.ts';
import {
  activeSystemReminders,
  DEFINITION_REMINDER,
  DEFINITION_REMINDER_SOURCE_KIND,
  ensureSystemReminders,
  PROGRESS_REMINDER,
  PROGRESS_REMINDER_SOURCE_KIND,
  type SystemReminder,
  systemReminderMessage,
} from '../src/system-reminder.ts';
import type { UserMessage } from '../src/types.ts';
import { makeMessage, makeSession, textBlock } from './helpers.ts';

/** 把提醒消息作为 user/message 事件放进会话日志。 */
function reminderEvent(reminder: SystemReminder, text?: string) {
  const message = systemReminderMessage(reminder);
  return {
    type: 'user/message',
    seq: 0,
    time: 0,
    surfaceOp: 'append',
    data: text === undefined ? message : { ...message, content: [textBlock(text)] },
  } as never;
}

/** 消息纯文本。 */
function textOf(message: UserMessage): string {
  return message.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
}

/** 提取消息列表中指定 kind 的提醒消息。 */
function ofKind(messages: readonly UserMessage[], kind: string): UserMessage[] {
  return messages.filter((message) => message.source.kind === kind);
}

const BOTH = [PROGRESS_REMINDER, DEFINITION_REMINDER];

describe('systemReminderMessage', () => {
  it.each(BOTH)('$kind 是带专属 source 的 user 消息，文本被 system-reminder 包裹', (reminder) => {
    const message = systemReminderMessage(reminder);
    const text = textOf(message);
    expect(message.role).toBe('user');
    expect(message.source.kind).toBe(reminder.kind);
    expect(text.startsWith('<system-reminder>\n')).toBe(true);
    expect(text.endsWith('\n</system-reminder>')).toBe(true);
    expect(text).not.toMatch(/does not override/i);
  });

  it('进度提醒要求边做边说，而不是只在任务结束时说明', () => {
    const text = textOf(systemReminderMessage(PROGRESS_REMINDER));
    expect(text).toMatch(/not (only|just|wait)[^.]*(finish|end|complete)/i);
    expect(text).toMatch(/plan/i);
  });

  it('定义提醒携带完整消息定义原文，进度提醒不携带', () => {
    expect(textOf(systemReminderMessage(DEFINITION_REMINDER))).toContain(
      COMPLETE_MESSAGE_DEFINITION,
    );
    expect(textOf(systemReminderMessage(PROGRESS_REMINDER))).not.toContain(
      COMPLETE_MESSAGE_DEFINITION,
    );
  });

  it.each(BOTH)('$kind 不被识别为插件自产压缩日志消息，记为系统消息参与索引', (reminder) => {
    expect(isPluginOwnedSource(systemReminderMessage(reminder).source)).toBe(false);
  });

  it('每次构造使用新的消息 id', () => {
    expect(systemReminderMessage(DEFINITION_REMINDER).id).not.toBe(
      systemReminderMessage(DEFINITION_REMINDER).id,
    );
  });
});

describe('activeSystemReminders', () => {
  const off = { omEnabled: false, recallEnabled: false };

  it('OM 启用时两条都启用', () => {
    expect(activeSystemReminders({ ...off, omEnabled: true }).map((r) => r.kind)).toEqual([
      PROGRESS_REMINDER_SOURCE_KIND,
      DEFINITION_REMINDER_SOURCE_KIND,
    ]);
  });

  it('OM 关闭但召回启用时只启用定义提醒', () => {
    expect(activeSystemReminders({ ...off, recallEnabled: true }).map((r) => r.kind)).toEqual([
      DEFINITION_REMINDER_SOURCE_KIND,
    ]);
  });

  it('全部关闭时不启用任何提醒', () => {
    expect(activeSystemReminders(off)).toEqual([]);
  });
});

describe('ensureSystemReminders', () => {
  const claimed = makeMessage({ content: [textBlock('请做点事')] }) as unknown as UserMessage;

  it('表层与本 step 都没有时按顺序追加到末尾，并保留原有消息顺序', () => {
    const session = makeSession({ events: [] });
    const result = ensureSystemReminders(session, [claimed], BOTH);
    expect(result.map((message) => message.source.kind)).toEqual([
      claimed.source.kind,
      PROGRESS_REMINDER_SOURCE_KIND,
      DEFINITION_REMINDER_SOURCE_KIND,
    ]);
    expect(result[0]).toBe(claimed);
  });

  it('本 step 已带上时不再追加', () => {
    const session = makeSession({ events: [] });
    const once = ensureSystemReminders(session, [claimed], BOTH);
    const twice = ensureSystemReminders(session, once, BOTH);
    expect(twice).toEqual(once);
  });

  it('表层已有一条时只补另一条', () => {
    const session = makeSession({ events: [reminderEvent(PROGRESS_REMINDER)] });
    const result = ensureSystemReminders(session, [claimed], BOTH);
    expect(ofKind(result, PROGRESS_REMINDER_SOURCE_KIND)).toHaveLength(0);
    expect(ofKind(result, DEFINITION_REMINDER_SOURCE_KIND)).toHaveLength(1);
  });

  it('表层两条都有时不追加', () => {
    const session = makeSession({
      events: [reminderEvent(PROGRESS_REMINDER), reminderEvent(DEFINITION_REMINDER)],
    });
    expect(ensureSystemReminders(session, [claimed], BOTH)).toEqual([claimed]);
  });

  it('提醒已被压缩遮蔽（在日志中但不在表层）时重新追加', () => {
    const session = makeSession({ events: [reminderEvent(DEFINITION_REMINDER)], surfaceNodes: [] });
    const result = ensureSystemReminders(session, [claimed], [DEFINITION_REMINDER]);
    expect(ofKind(result, DEFINITION_REMINDER_SOURCE_KIND)).toHaveLength(1);
  });

  it('表层只有过期文本的提醒时补发当前文本', () => {
    const session = makeSession({
      events: [reminderEvent(DEFINITION_REMINDER, '<system-reminder>旧定义</system-reminder>')],
    });
    const added = ofKind(
      ensureSystemReminders(session, [claimed], [DEFINITION_REMINDER]),
      DEFINITION_REMINDER_SOURCE_KIND,
    );
    expect(added).toHaveLength(1);
    expect(added[0]?.content).toEqual(systemReminderMessage(DEFINITION_REMINDER).content);
  });

  it('另一条提醒的 kind 带着相同文本也不算已存在', () => {
    const session = makeSession({
      events: [reminderEvent(PROGRESS_REMINDER, DEFINITION_REMINDER.text)],
    });
    const result = ensureSystemReminders(session, [claimed], [DEFINITION_REMINDER]);
    expect(ofKind(result, DEFINITION_REMINDER_SOURCE_KIND)).toHaveLength(1);
  });

  it('未启用的提醒不追加', () => {
    const session = makeSession({ events: [] });
    expect(ensureSystemReminders(session, [claimed], [])).toEqual([claimed]);
  });

  it('不修改传入的消息数组', () => {
    const session = makeSession({ events: [] });
    const input = [claimed];
    ensureSystemReminders(session, input, BOTH);
    expect(input).toEqual([claimed]);
  });
});
