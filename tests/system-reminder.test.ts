// system-reminder 单元测试：验证提醒 source、构造、启用条件与表层去重，
// 覆盖进度提醒的已结束 step/toolcall 门槛、计数起点、压缩遮蔽及定义提醒补发。
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  ToolCallId,
} from '@deepseek-ai/dsh-llm';
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
import type { ContentBlock, Session, UserMessage } from '../src/types.ts';
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

/** 追加带模型消息的 step，默认闭合；表层和日志行为由共享 Session 模拟提供。 */
function appendStep(
  session: Session,
  step: number,
  calls: number,
  options: {
    turn?: number;
    input?: UserMessage;
    text?: string;
    reasoning?: string;
    ended?: boolean;
    interrupted?: boolean;
    callName?: string;
    arguments?: string;
  } = {},
): void {
  const turn = options.turn ?? 1;
  session.append('step/start', { turn, step });
  if (options.input) session.append('user/message', options.input, { surfaceOp: 'append' });
  const content: ContentBlock[] = [];
  if (options.text !== undefined) content.push(textBlock(options.text));
  if (options.reasoning !== undefined) content.push({ type: 'reasoning', text: options.reasoning });
  for (let index = 0; index < calls; index += 1) {
    content.push({
      type: 'tool-call',
      id: ToolCallId(`call-${turn}-${step}-${index}`),
      name: options.callName ?? 'inspect',
      arguments: options.arguments ?? '{}',
    });
  }
  session.append(
    'assistant/message',
    {
      turn,
      step,
      message: createAssistantMessage({ content, source: { provider: 'mock', model: 'mock' } }),
      stream: [],
      ...(options.interrupted ? { interrupted: true as const } : {}),
    },
    { surfaceOp: 'append' },
  );
  if (options.ended !== false) session.append('step/end', { turn, step });
}

/** 生成从提醒接收 step 起的静默工具活动窗口。 */
function activitySession(counts: readonly number[]): Session {
  const session = makeSession();
  counts.forEach((calls, index) => {
    appendStep(session, index + 1, calls, {
      ...(index === 0 ? { input: systemReminderMessage(PROGRESS_REMINDER) } : {}),
    });
  });
  return session;
}

/** 只运行进度提醒检查，不默认传入新用户消息。 */
function progressReminders(session: Session, messages: readonly UserMessage[] = []): UserMessage[] {
  return ofKind(
    ensureSystemReminders(session, messages, [PROGRESS_REMINDER]),
    PROGRESS_REMINDER.kind,
  );
}

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

  it('recall 启用时无论是否有 history 块均启用定义提醒', () => {
    expect(
      activeSystemReminders({ ...off, recallEnabled: true }, false).map((r) => r.kind),
    ).toEqual([DEFINITION_REMINDER_SOURCE_KIND]);
    expect(activeSystemReminders({ ...off, recallEnabled: true }, true).map((r) => r.kind)).toEqual(
      [DEFINITION_REMINDER_SOURCE_KIND],
    );
  });

  it('recall 关闭时仅在表层有 history 块时启用定义提醒', () => {
    expect(
      activeSystemReminders({ ...off, omEnabled: true, recallEnabled: false }, false).map(
        (r) => r.kind,
      ),
    ).toEqual([PROGRESS_REMINDER_SOURCE_KIND]);
    expect(
      activeSystemReminders({ ...off, omEnabled: true, recallEnabled: false }, true).map(
        (r) => r.kind,
      ),
    ).toEqual([PROGRESS_REMINDER_SOURCE_KIND, DEFINITION_REMINDER_SOURCE_KIND]);
  });

  it('全部关闭且无 history 块时不启用任何提醒', () => {
    expect(activeSystemReminders(off, false)).toEqual([]);
  });

  it('全部关闭但有 history 块时启用定义提醒', () => {
    expect(activeSystemReminders(off, true).map((r) => r.kind)).toEqual([
      DEFINITION_REMINDER_SOURCE_KIND,
    ]);
  });
});

describe('进度提醒的表层活动窗口', () => {
  it('表层同 kind 文本过期也不补发，待输入同 kind 同样去重', () => {
    const stale = createUserMessage({
      content: [textBlock('旧进度提醒')],
      source: { kind: PROGRESS_REMINDER.kind, form: 'instructions' },
    });
    expect(
      progressReminders(makeSession({ events: [reminderEvent(PROGRESS_REMINDER, '旧文案')] })),
    ).toHaveLength(0);
    expect(progressReminders(makeSession(), [stale])).toEqual([stale]);
  });

  it('提醒只存在于被遮蔽日志中时重新注入', () => {
    const session = makeSession({ events: [reminderEvent(PROGRESS_REMINDER)], surfaceNodes: [] });
    expect(progressReminders(session)).toHaveLength(1);
  });

  it.each([
    { counts: [11], inject: false },
    { counts: [4, 4, 3], inject: false },
    { counts: [3, 3, 2, 2], inject: false },
    { counts: [3, 3, 3, 2], inject: true },
    { counts: Array.from({ length: 10 }, () => 1), inject: false },
    { counts: Array.from({ length: 11 }, () => 1), inject: true },
  ])('step 数与调用数同时达标才重发：$counts', ({ counts, inject }) => {
    expect(progressReminders(activitySession(counts))).toHaveLength(inject ? 1 : 0);
  });

  it('真实用户消息从接收 step 起计数，覆盖更早的高调用量', () => {
    const session = activitySession([20]);
    const user = createUserMessage({ content: [], source: { kind: 'user' } });
    appendStep(session, 2, 3, { input: user });
    appendStep(session, 3, 3);
    appendStep(session, 4, 3);
    expect(progressReminders(session)).toHaveLength(0);
    appendStep(session, 5, 2);
    expect(progressReminders(session)).toHaveLength(1);
  });

  it.each([false, true])('非空模型 text 从下个 step 起计数，中断标记=%s', (interrupted) => {
    const session = activitySession([3, 3, 3, 2]);
    appendStep(session, 5, 30, { text: ' 已定位问题。 ', interrupted });
    appendStep(session, 6, 3);
    appendStep(session, 7, 3);
    appendStep(session, 8, 3);
    expect(progressReminders(session)).toHaveLength(0);
    appendStep(session, 9, 1);
    expect(progressReminders(session)).toHaveLength(0);
    appendStep(session, 10, 1);
    expect(progressReminders(session)).toHaveLength(1);
  });

  it('空白 text、reasoning、工具结果和其他提醒都不重置', () => {
    const session = activitySession([3]);
    session.append('user/message', systemReminderMessage(DEFINITION_REMINDER), {
      surfaceOp: 'append',
    });
    session.append(
      'tool/result',
      {
        turn: 1,
        step: 1,
        message: createToolResultMessage({
          callId: ToolCallId('call-1-1-0'),
          content: [textBlock('工具返回的文本')],
          isError: true,
        }),
      },
      { surfaceOp: 'append' },
    );
    appendStep(session, 2, 3, { text: ' \n\t', reasoning: '分析工具结果' });
    appendStep(session, 3, 3, { reasoning: '下一步思考' });
    appendStep(session, 4, 2);
    expect(progressReminders(session)).toHaveLength(1);
  });

  it('待输入真实用户消息立即重置，但首次提醒缺失时仍注入', () => {
    const user = createUserMessage({ content: [textBlock('新任务')], source: { kind: 'user' } });
    expect(progressReminders(activitySession([3, 3, 3, 2]), [user])).toHaveLength(0);
    expect(progressReminders(makeSession(), [user])).toHaveLength(1);
  });

  it('待输入的定义提醒不重置，进度提醒则去重', () => {
    const session = activitySession([3, 3, 3, 2]);
    const definition = systemReminderMessage(DEFINITION_REMINDER);
    expect(progressReminders(session, [definition])).toHaveLength(1);
    const progress = systemReminderMessage(PROGRESS_REMINDER);
    expect(progressReminders(session, [progress])).toEqual([progress]);
  });

  it('当前未结束的 step 和只有 attempt 的失败 step 不算', () => {
    const session = activitySession([4, 4, 3]);
    session.append('step/start', { turn: 1, step: 4 });
    session.append('assistant/attempt', { turn: 1, step: 4, stream: [] });
    session.append('step/end', { turn: 1, step: 4 });
    expect(progressReminders(session)).toHaveLength(0);
    appendStep(session, 5, 1, { ended: false });
    expect(progressReminders(session)).toHaveLength(0);
    session.append('step/end', { turn: 1, step: 5 });
    expect(progressReminders(session)).toHaveLength(1);
  });

  it('重复 step/end 不重复计数，跨 turn 的相同 step 编号分别计数', () => {
    const session = activitySession([4, 4, 3]);
    session.append('step/end', { turn: 1, step: 3 });
    expect(progressReminders(session)).toHaveLength(0);
    appendStep(session, 1, 0, { turn: 2 });
    expect(progressReminders(session)).toHaveLength(1);
  });

  it('每次重发从提醒接收 step 起重新累计，定义提醒不跟随重发', () => {
    const session = activitySession([3, 3, 3, 2]);
    session.append('user/message', systemReminderMessage(DEFINITION_REMINDER), {
      surfaceOp: 'append',
    });
    const result = ensureSystemReminders(session, [], BOTH);
    expect(result.map((message) => message.source.kind)).toEqual([PROGRESS_REMINDER.kind]);
    const reminder = result[0];
    if (!reminder) throw new Error('应重发进度提醒');
    appendStep(session, 5, 3, { input: reminder });
    appendStep(session, 6, 3);
    appendStep(session, 7, 3);
    expect(progressReminders(session)).toHaveLength(0);
    appendStep(session, 8, 2);
    expect(progressReminders(session)).toHaveLength(1);
  });

  it('包装工具按顶层调用计数，不展开内部调用', () => {
    const session = activitySession([1]);
    for (let step = 2; step <= 4; step += 1)
      appendStep(session, step, 1, {
        callName: 'parallel',
        arguments: JSON.stringify({ tool_uses: Array.from({ length: 20 }, () => ({})) }),
      });
    expect(progressReminders(session)).toHaveLength(0);
  });

  it('被遮蔽的模型消息和它们的 text 不参与计数或重置', () => {
    const session = activitySession([20]);
    appendStep(session, 2, 0, { text: '将被遮蔽的记录' });
    appendStep(session, 3, 3);
    appendStep(session, 4, 3);
    appendStep(session, 5, 3);
    const events = session.snapshotEvents();
    const nodes = session.surface.nodes.filter((seq) => {
      const event = events[seq];
      return event?.type !== 'assistant/message' || event.data.step > 2;
    });
    const surface = makeSession({ events: [...events], surfaceNodes: nodes });
    expect(progressReminders(surface)).toHaveLength(0);
    appendStep(surface, 6, 2);
    expect(progressReminders(surface)).toHaveLength(1);
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
