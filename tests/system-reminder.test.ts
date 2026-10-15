// system-reminder 单元测试：验证提醒 source、构造、启用条件与表层去重，
// 覆盖进度提醒的已结束 step/toolcall 门槛、计数起点与压缩遮蔽。
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  ToolCallId,
} from '@deepseek-ai/dsh-llm';
import { describe, expect, it } from 'vitest';
import { isPluginOwnedSource } from '../src/constants.ts';
import { indexCompleteMessages } from '../src/log-index.ts';
import {
  activeSystemReminders,
  ensureSystemReminders,
  PROGRESS_REMINDER,
  PROGRESS_REMINDER_SOURCE_KIND,
  type ProgressIdleOptions,
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

/** 非本插件产生的其他来源提醒消息。 */
function foreignReminder(): UserMessage {
  return createUserMessage({
    content: [textBlock('其他提醒')],
    source: { kind: 'plugin:other:reminder', form: 'instructions' } as never,
  });
}

/** 提取消息列表中指定 kind 的提醒消息。 */
function ofKind(messages: readonly UserMessage[], kind: string): UserMessage[] {
  return messages.filter((message) => message.source.kind === kind);
}

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

/** 只运行进度提醒检查，不默认传入新用户消息；idle 缺省沿用默认判定。 */
function progressReminders(
  session: Session,
  messages: readonly UserMessage[] = [],
  idle?: ProgressIdleOptions,
): UserMessage[] {
  return ofKind(
    ensureSystemReminders(session, messages, [PROGRESS_REMINDER], idle),
    PROGRESS_REMINDER.kind,
  );
}

describe('systemReminderMessage', () => {
  it.each([PROGRESS_REMINDER])(
    '$kind 是带专属 source 的 user 消息，文本被 system-reminder 包裹',
    (reminder) => {
      const message = systemReminderMessage(reminder);
      const text = textOf(message);
      expect(message.role).toBe('user');
      expect(message.source.kind).toBe(reminder.kind);
      expect(text.startsWith('<system-reminder>\n')).toBe(true);
      expect(text.endsWith('\n</system-reminder>')).toBe(true);
      expect(text).not.toMatch(/does not override/i);
    },
  );

  it('进度提醒首行声明为本会话对你的要求，活动重发版本保持同一首行', () => {
    const firstLine = '在本会话中，你应当持续输出文本，记录阶段性成果：';
    const urgent = ensureSystemReminders(activitySession([3, 3, 3, 2]), [], [PROGRESS_REMINDER]);
    for (const message of [systemReminderMessage(PROGRESS_REMINDER), ...urgent]) {
      expect(textOf(message).split('\n')[1]).toBe(firstLine);
    }
    expect(urgent).toHaveLength(1);
  });

  it.each([PROGRESS_REMINDER])(
    '$kind 不被识别为插件自产压缩日志消息，作为系统消息不占完整消息 index',
    (reminder) => {
      expect(isPluginOwnedSource(systemReminderMessage(reminder).source)).toBe(false);
      const session = makeSession({ events: [reminderEvent(reminder)] });
      expect(indexCompleteMessages(session)).toEqual([]);
    },
  );

  it('每次构造使用新的消息 id', () => {
    expect(systemReminderMessage(PROGRESS_REMINDER).id).not.toBe(
      systemReminderMessage(PROGRESS_REMINDER).id,
    );
  });
});

describe('activeSystemReminders', () => {
  it.each([
    { omEnabled: true, progressReminderEnabled: true, active: true },
    { omEnabled: true, progressReminderEnabled: false, active: false },
    { omEnabled: false, progressReminderEnabled: true, active: false },
    { omEnabled: false, progressReminderEnabled: false, active: false },
  ])(
    'omEnabled=$omEnabled 且 progressReminderEnabled=$progressReminderEnabled 时启用=$active',
    ({ active, ...config }) => {
      expect(activeSystemReminders(config)).toEqual(active ? [PROGRESS_REMINDER] : []);
    },
  );
});

describe('进度提醒的表层活动窗口', () => {
  it('只有条件 2 在正文底部追加立刻记录要求，同 kind 仍去重和重置计数', () => {
    const first = progressReminders(makeSession())[0];
    expect(first?.content).toEqual(systemReminderMessage(PROGRESS_REMINDER).content);
    const hidden = makeSession({ events: [reminderEvent(PROGRESS_REMINDER)], surfaceNodes: [] });
    expect(progressReminders(hidden)[0]?.content).toEqual(first?.content);

    const session = activitySession([3, 3, 3, 2]);
    const urgent = progressReminders(session)[0];
    if (!urgent) throw new Error('条件 2 应注入进度提醒');
    expect(urgent.source).toEqual(first?.source);
    expect(textOf(urgent)).toBe(
      PROGRESS_REMINDER.text.replace(
        '\n</system-reminder>',
        '\n你应当*立刻*输出一条记录\n</system-reminder>',
      ),
    );
    expect(progressReminders(session, [urgent])).toEqual([urgent]);
    appendStep(session, 5, 3, { input: urgent });
    expect(progressReminders(session)).toHaveLength(0);
  });

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
    session.append('user/message', foreignReminder(), { surfaceOp: 'append' });
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

  it('ask_user_question 调用与非空 text 一样重置窗口，且本 step 不计数', () => {
    const asked = activitySession([3, 3, 3]);
    appendStep(asked, 4, 4, { callName: 'ask_user_question' });
    appendStep(asked, 5, 3);
    appendStep(asked, 6, 3);
    appendStep(asked, 7, 3);
    expect(progressReminders(asked)).toHaveLength(0);
    appendStep(asked, 8, 3);
    expect(progressReminders(asked)).toHaveLength(1);

    const other = activitySession([3, 3, 3]);
    appendStep(other, 4, 4, { callName: 'inspect' });
    expect(progressReminders(other)).toHaveLength(1);
  });

  it('待输入真实用户消息立即重置，但首次提醒缺失时仍注入', () => {
    const user = createUserMessage({ content: [textBlock('新任务')], source: { kind: 'user' } });
    expect(progressReminders(activitySession([3, 3, 3, 2]), [user])).toHaveLength(0);
    expect(progressReminders(makeSession(), [user])).toHaveLength(1);
  });

  it('待输入的其他提醒不重置，进度提醒则去重', () => {
    const session = activitySession([3, 3, 3, 2]);
    expect(progressReminders(session, [foreignReminder()])).toHaveLength(1);
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

  it('每次重发从提醒接收 step 起重新累计', () => {
    const session = activitySession([3, 3, 3, 2]);
    const result = ensureSystemReminders(session, [], [PROGRESS_REMINDER]);
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
  const only = [PROGRESS_REMINDER];

  it('表层与本 step 都没有时追加到末尾，并保留原有消息顺序', () => {
    const session = makeSession({ events: [] });
    const result = ensureSystemReminders(session, [claimed], only);
    expect(result.map((message) => message.source.kind)).toEqual([
      claimed.source.kind,
      PROGRESS_REMINDER_SOURCE_KIND,
    ]);
    expect(result[0]).toBe(claimed);
  });

  it('本 step 已带上时不再追加', () => {
    const session = makeSession({ events: [] });
    const once = ensureSystemReminders(session, [claimed], only);
    expect(ensureSystemReminders(session, once, only)).toEqual(once);
  });

  it('表层已有进度提醒时不追加', () => {
    const session = makeSession({ events: [reminderEvent(PROGRESS_REMINDER)] });
    expect(ensureSystemReminders(session, [claimed], only)).toEqual([claimed]);
  });

  it('未启用的提醒不追加', () => {
    const session = makeSession({ events: [] });
    expect(ensureSystemReminders(session, [claimed], [])).toEqual([claimed]);
  });

  it('不修改传入的消息数组', () => {
    const session = makeSession({ events: [] });
    const input = [claimed];
    ensureSystemReminders(session, input, only);
    expect(input).toEqual([claimed]);
  });
});

describe('进度提醒的可配置活动重发', () => {
  const idle = (steps: number, toolCalls: number, enabled = true): ProgressIdleOptions => ({
    enabled,
    steps,
    toolCalls,
  });

  it('关闭活动重发后只保留缺失补发，且补发文本不带立刻记录要求', () => {
    const session = activitySession([30, 30, 30, 30, 30]);
    expect(progressReminders(session, [], idle(4, 10, false))).toHaveLength(0);
    const first = progressReminders(makeSession(), [], idle(4, 10, false));
    expect(first).toHaveLength(1);
    expect(textOf(first[0] as UserMessage)).toBe(PROGRESS_REMINDER.text);
    const hidden = makeSession({ events: [reminderEvent(PROGRESS_REMINDER)], surfaceNodes: [] });
    expect(progressReminders(hidden, [], idle(4, 10, false))).toHaveLength(1);
  });

  it('省略选项时沿用 4 个 step 与 10 次调用', () => {
    expect(progressReminders(activitySession([3, 3, 3, 2]))).toHaveLength(1);
    expect(progressReminders(activitySession([3, 3, 2, 2]))).toHaveLength(0);
    expect(progressReminders(activitySession([3, 3, 3, 2]), [], idle(4, 10))).toHaveLength(1);
  });

  it.each([
    { counts: [1], steps: 2, toolCalls: 1, inject: false },
    { counts: [1, 1], steps: 2, toolCalls: 1, inject: true },
    { counts: [1, 1], steps: 2, toolCalls: 2, inject: false },
    { counts: [2, 1], steps: 2, toolCalls: 2, inject: true },
    { counts: [0, 0, 0], steps: 3, toolCalls: 0, inject: false },
    { counts: [1, 0, 0], steps: 3, toolCalls: 0, inject: true },
    { counts: [5], steps: 1, toolCalls: 4, inject: true },
    { counts: [4], steps: 1, toolCalls: 4, inject: false },
    { counts: [9, 9, 9, 9, 9], steps: 6, toolCalls: 0, inject: false },
    { counts: [9, 9, 9, 9, 9, 1], steps: 6, toolCalls: 0, inject: true },
    { counts: [3, 3, 3, 2], steps: 4, toolCalls: 20, inject: false },
  ])(
    '自定义阈值 steps≥$steps 且 toolCalls>$toolCalls：$counts → $inject',
    ({ counts, steps, toolCalls, inject }) => {
      const result = progressReminders(activitySession(counts), [], idle(steps, toolCalls));
      expect(result).toHaveLength(inject ? 1 : 0);
      if (inject) expect(textOf(result[0] as UserMessage)).toContain('你应当*立刻*输出一条记录');
    },
  );

  it('自定义阈值下重发后仍从提醒接收 step 起重新累计', () => {
    const session = activitySession([1, 1]);
    const urgent = progressReminders(session, [], idle(2, 1))[0];
    if (!urgent) throw new Error('应重发');
    appendStep(session, 3, 1, { input: urgent });
    expect(progressReminders(session, [], idle(2, 1))).toHaveLength(0);
    appendStep(session, 4, 1);
    expect(progressReminders(session, [], idle(2, 1))).toHaveLength(1);
  });
});
