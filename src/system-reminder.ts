/**
 * system-reminder：以 <system-reminder> 用户消息向主会话注入进度提醒，不进系统提示词。
 * 进度提醒：表层缺少同 kind 消息时补发；开启活动重发时，无记录活动累计至少 N 个已结束 step、
 * 且工具调用超过 M 次时重发（N、M 与开关均来自配置，默认 4 与 10）。
 * 每个 step 检查表层；真实用户消息、非空模型 text、ask_user_question 调用与进度提醒重置活动窗口。
 * 导出 PROGRESS_REMINDER_SOURCE_KIND / ProgressReminderSource / SystemReminder /
 * PROGRESS_REMINDER / ProgressIdleOptions / DEFAULT_PROGRESS_IDLE / progressIdleOptions /
 * systemReminderMessage / activeSystemReminders / ensureSystemReminders。
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { PluginConfig } from './config.ts';
import { ASK_USER_QUESTION_TOOL_NAME } from './constants.ts';
import type { Session, SessionEvent, UserMessage } from './types.ts';

/** 进度提醒的 producer-owned source kind（区别于压缩日志消息的 plugin:dsh-plugin-om）。 */
export const PROGRESS_REMINDER_SOURCE_KIND = 'plugin:dsh-plugin-om:progress';

/** 进度提醒消息的 source。 */
export type ProgressReminderSource = {
  readonly kind: typeof PROGRESS_REMINDER_SOURCE_KIND;
  readonly form: 'instructions';
};

/** 一种提醒：source kind 与全文（含 system-reminder 包裹）。 */
export type SystemReminder = {
  readonly kind: typeof PROGRESS_REMINDER_SOURCE_KIND;
  readonly text: string;
};

/** 用 system-reminder 标签包裹提醒正文。 */
function wrap(lines: readonly string[]): string {
  return ['<system-reminder>', ...lines, '</system-reminder>'].join('\n');
}

/** 进度提醒。 */
export const PROGRESS_REMINDER: SystemReminder = {
  kind: PROGRESS_REMINDER_SOURCE_KIND,
  text: wrap([
    '在本会话中，你应当持续输出文本，记录阶段性成果：',
    '- 1-2句话概括最近几步，不必覆盖所有细节',
    '- 承上启下，突出要点，例如“读 f1，发现 L1 关联了 f2-L2，读 f2”，“m1 完成，按计划开始 m2”',
    '- 记录后继续完成任务，不要等待确认',
    '- 记录仅是中间产物，最终输出需要另行构建',
  ]),
};

/** 构造一条新的提醒消息。 */
export function systemReminderMessage(reminder: SystemReminder): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: reminder.text }],
    source: { kind: reminder.kind, form: 'instructions' },
  });
}

/** 按配置返回应注入的提醒：omEnabled 与 progressReminderEnabled 同时开启时为进度提醒。 */
export function activeSystemReminders(
  config: Pick<PluginConfig, 'omEnabled' | 'progressReminderEnabled'>,
): SystemReminder[] {
  return config.omEnabled && config.progressReminderEnabled ? [PROGRESS_REMINDER] : [];
}

/** 活动重发判定：开关、静默窗口内已结束 step 数下限、工具调用数须超过的值。 */
export type ProgressIdleOptions = {
  readonly enabled: boolean;
  readonly steps: number;
  readonly toolCalls: number;
};

/** 默认活动重发判定，与配置默认值一致。 */
export const DEFAULT_PROGRESS_IDLE: ProgressIdleOptions = Object.freeze({
  enabled: true,
  steps: 4,
  toolCalls: 10,
});

/** 由配置取出活动重发判定。 */
export function progressIdleOptions(
  config: Pick<
    PluginConfig,
    'progressReminderIdleEnabled' | 'progressReminderIdleSteps' | 'progressReminderIdleToolCalls'
  >,
): ProgressIdleOptions {
  return {
    enabled: config.progressReminderIdleEnabled,
    steps: config.progressReminderIdleSteps,
    toolCalls: config.progressReminderIdleToolCalls,
  };
}

/** 进度提醒在表层缺失，或开启活动重发且静默窗口达到 idle 阈值时补发。 */
function progressReminderTrigger(
  surface: readonly SessionEvent[],
  events: readonly SessionEvent[],
  messages: readonly UserMessage[],
  idle: ProgressIdleOptions,
): 'missing' | 'activity' | undefined {
  if (messages.some((message) => message.source.kind === PROGRESS_REMINDER_SOURCE_KIND))
    return undefined;
  const present = surface.some(
    (event) =>
      event.type === 'user/message' && event.data.source.kind === PROGRESS_REMINDER_SOURCE_KIND,
  );
  if (!present) return 'missing';
  if (!idle.enabled) return undefined;
  if (messages.some((message) => message.source.kind === 'user')) return undefined;

  const ended = new Set<string>();
  for (const event of events) {
    if (event.type === 'step/end') ended.add(`${event.data.turn}:${event.data.step}`);
  }
  const steps = new Set<string>();
  let toolCalls = 0;
  let textStep: string | undefined;
  for (const event of surface) {
    if (event.type === 'user/message') {
      const kind = event.data.source.kind;
      if (kind === 'user' || kind === PROGRESS_REMINDER_SOURCE_KIND) {
        steps.clear();
        toolCalls = 0;
        textStep = undefined;
      }
    } else if (event.type === 'assistant/message') {
      const { turn, step, message } = event.data;
      const key = `${turn}:${step}`;
      const speaks = message.content.some(
        (block) =>
          (block.type === 'text' && block.text.trim() !== '') ||
          (block.type === 'tool-call' && block.name === ASK_USER_QUESTION_TOOL_NAME),
      );
      if (speaks) {
        steps.clear();
        toolCalls = 0;
        textStep = key;
      } else if (key !== textStep && ended.has(key)) {
        steps.add(key);
        toolCalls += message.content.filter((block) => block.type === 'tool-call').length;
      }
    }
  }
  return steps.size >= idle.steps && toolCalls > idle.toolCalls ? 'activity' : undefined;
}

/**
 * 按表层与待输入消息补发提醒，追加到末尾且不修改入参。
 * 进度提醒按 kind 去重并按 idle 检测活动窗口（缺省沿用默认阈值），活动达标时追加立刻记录要求。
 */
export function ensureSystemReminders(
  session: Session,
  messages: readonly UserMessage[],
  reminders: readonly SystemReminder[],
  idle: ProgressIdleOptions = DEFAULT_PROGRESS_IDLE,
): UserMessage[] {
  const result = [...messages];
  if (reminders.length === 0) return result;
  const events = session.snapshotEvents();
  const surface = session.surface.nodes.flatMap((seq) => {
    const event = events[seq];
    return event === undefined ? [] : [event];
  });
  for (const reminder of reminders) {
    const trigger = progressReminderTrigger(surface, events, result, idle);
    if (trigger === undefined) continue;
    const progress =
      trigger === 'activity'
        ? {
            ...reminder,
            text: reminder.text.replace(
              '\n</system-reminder>',
              '\n你应当*立刻*输出一条记录\n</system-reminder>',
            ),
          }
        : reminder;
    result.push(systemReminderMessage(progress));
  }
  return result;
}
