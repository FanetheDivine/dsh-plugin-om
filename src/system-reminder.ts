/**
 * system-reminder：以 <system-reminder> 用户消息向主会话注入插件提醒，不进系统提示词。
 * - 进度提醒：OM 启用时提示模型边做边简述计划与进展。
 * - 完整消息定义提醒：OM 或 recall 启用时说明 `<history>` 块与 recall 共用的完整消息 index。
 * 每个 step 检查表层，被压缩遮蔽或文本过期时补发，保证模型请求中每种恒有一条。
 * 导出 PROGRESS_REMINDER_SOURCE_KIND / DEFINITION_REMINDER_SOURCE_KIND / 对应 source 类型 /
 * SystemReminder / PROGRESS_REMINDER / DEFINITION_REMINDER / systemReminderMessage /
 * activeSystemReminders / ensureSystemReminders。
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { PluginConfig } from './config.ts';
import { COMPLETE_MESSAGE_DEFINITION } from './constants.ts';
import type { Session, UserMessage } from './types.ts';

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
    'Narrate your progress while you work, not only when the task is finished.',
    '- Before your first tool call on a task, state your plan in one or two sentences.',
    '- After each meaningful chunk of work (a group of related tool calls, a finished investigation, a completed edit), briefly report what you found or did and what you will do next, then continue.',
    '- Do not narrate every individual tool call; one short note per chunk is enough.',
    '- Do not save all commentary for the final answer. The final answer summarizes outcomes.',
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

/**
 * 保证本 step 之后的消息列表中每种指定提醒各有一条当前文本：本 step 已带上或表层已有则跳过，
 * 否则按顺序追加到末尾。返回新数组，不修改入参。
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
    return event?.type === 'user/message' ? [event.data] : [];
  });
  for (const reminder of reminders) {
    const present = [...result, ...surface].some((message) =>
      isCurrent(reminder, message.source, message.content),
    );
    if (!present) result.push(systemReminderMessage(reminder));
  }
  return result;
}
