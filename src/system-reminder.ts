/**
 * system-reminder：以 <system-reminder> 用户消息向主会话注入插件提醒，不进系统提示词。
 * - 进度提醒：表层缺少同 kind 消息时补发，或无记录活动累计至少 4 个已结束 step、超过 10 次工具调用时重发。
 * - 完整消息定义提醒：OM 或 recall 启用时说明 `<history>` 块与 recall 共用的完整消息 index。
 * 每个 step 检查表层；真实用户消息、非空模型 text 与进度提醒重置活动窗口，定义提醒缺失或文本过期时补发。
 * 导出 PROGRESS_REMINDER_SOURCE_KIND / DEFINITION_REMINDER_SOURCE_KIND / 对应 source 类型 /
 * SystemReminder / PROGRESS_REMINDER / DEFINITION_REMINDER / systemReminderMessage /
 * activeSystemReminders / ensureSystemReminders。
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { PluginConfig } from './config.ts';
import { COMPLETE_MESSAGE_DEFINITION } from './constants.ts';
import type { Session, SessionEvent, UserMessage } from './types.ts';

/** 进度提醒的 producer-owned source kind（区别于压缩日志消息的 plugin:dsh-plugin-om）。 */
export const PROGRESS_REMINDER_SOURCE_KIND = 'plugin:dsh-plugin-om:progress';

/** 完整消息定义提醒的 producer-owned source kind。 */
export const DEFINITION_REMINDER_SOURCE_KIND = 'plugin:dsh-plugin-om:definition';

/** 进度提醒消息的 source。 */
export type ProgressReminderSource = {
  readonly kind: typeof PROGRESS_REMINDER_SOURCE_KIND;
  readonly form: 'instructions';
};

/** 完整消息定义提醒消息的 source。 */
export type DefinitionReminderSource = {
  readonly kind: typeof DEFINITION_REMINDER_SOURCE_KIND;
  readonly form: 'instructions';
};

/** 一种提醒：source kind 与全文（含 system-reminder 包裹）。 */
export type SystemReminder = {
  readonly kind: typeof PROGRESS_REMINDER_SOURCE_KIND | typeof DEFINITION_REMINDER_SOURCE_KIND;
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
    '在工作过程中持续输出文本，用1-2句话记录最近几步的成果：',
    '- 概括为主，不必覆盖所有细节',
    '- 记录要承上启下，例如“读 f1，发现关联了 f2、f3，读这两个文件”，“m1 完成，按计划开始 m2”',
    '- 记录后继续完成任务，不要等待确认',
    '- 记录仅是中间产物，最终输出需要另行构建',
  ]),
};

/** 完整消息定义提醒。 */
export const DEFINITION_REMINDER: SystemReminder = {
  kind: DEFINITION_REMINDER_SOURCE_KIND,
  text: wrap([COMPLETE_MESSAGE_DEFINITION]),
};

/** 构造一条新的提醒消息。 */
export function systemReminderMessage(reminder: SystemReminder): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: reminder.text }],
    source: { kind: reminder.kind, form: 'instructions' },
  });
}

/** 按配置与当前表层是否有 history 块返回应注入的提醒，顺序固定：进度在前，定义在后。 */
export function activeSystemReminders(
  config: Pick<PluginConfig, 'omEnabled' | 'recallEnabled'>,
  hasHistory: boolean,
): SystemReminder[] {
  const reminders: SystemReminder[] = [];
  if (config.omEnabled) reminders.push(PROGRESS_REMINDER);
  if (config.recallEnabled || hasHistory) {
    reminders.push(DEFINITION_REMINDER);
  }
  return reminders;
}

/** 消息是否为指定提醒的当前文本。 */
function isCurrent(
  reminder: SystemReminder,
  source: { kind?: string },
  content: readonly { type: string; text?: string }[],
): boolean {
  return (
    source.kind === reminder.kind &&
    content.length === 1 &&
    content[0]?.type === 'text' &&
    content[0].text === reminder.text
  );
}

/** 进度提醒在表层缺失，或静默窗口达到 4 个已结束 step 且超过 10 次调用时补发。 */
function progressReminderTrigger(
  surface: readonly SessionEvent[],
  events: readonly SessionEvent[],
  messages: readonly UserMessage[],
): 'missing' | 'activity' | undefined {
  if (messages.some((message) => message.source.kind === PROGRESS_REMINDER_SOURCE_KIND))
    return undefined;
  const present = surface.some(
    (event) =>
      event.type === 'user/message' && event.data.source.kind === PROGRESS_REMINDER_SOURCE_KIND,
  );
  if (!present) return 'missing';
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
      if (message.content.some((block) => block.type === 'text' && block.text.trim() !== '')) {
        steps.clear();
        toolCalls = 0;
        textStep = key;
      } else if (key !== textStep && ended.has(key)) {
        steps.add(key);
        toolCalls += message.content.filter((block) => block.type === 'tool-call').length;
      }
    }
  }
  return steps.size >= 4 && toolCalls > 10 ? 'activity' : undefined;
}

/**
 * 按表层与待输入消息补发提醒，追加到末尾且不修改入参。
 * 进度提醒按 kind 去重并检测活动窗口，活动达标时追加立刻记录要求；定义提醒缺失或文本过期时补发。
 */
export function ensureSystemReminders(
  session: Session,
  messages: readonly UserMessage[],
  reminders: readonly SystemReminder[],
): UserMessage[] {
  const result = [...messages];
  if (reminders.length === 0) return result;
  const events = session.snapshotEvents();
  const surface = session.surface.nodes.flatMap((seq) => {
    const event = events[seq];
    return event === undefined ? [] : [event];
  });
  const surfaceMessages = surface.flatMap((event) =>
    event.type === 'user/message' ? [event.data] : [],
  );
  for (const reminder of reminders) {
    if (reminder.kind === PROGRESS_REMINDER_SOURCE_KIND) {
      const trigger = progressReminderTrigger(surface, events, result);
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
    } else if (
      ![...result, ...surfaceMessages].some((message) =>
        isCurrent(reminder, message.source, message.content),
      )
    ) {
      result.push(systemReminderMessage(reminder));
    }
  }
  return result;
}
