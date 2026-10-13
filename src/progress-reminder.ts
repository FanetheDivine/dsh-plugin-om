/**
 * 进度提醒：以 <system-reminder> 用户消息提示模型边做边简述计划与进展。
 * 提醒不进系统提示词；每个 step 检查表层，被压缩遮蔽或文本过期时补发，保证模型请求中恒有一条。
 * 导出 PROGRESS_REMINDER_SOURCE_KIND / ProgressReminderSource / PROGRESS_REMINDER_TEXT /
 * progressReminderMessage / ensureProgressReminder。
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { Session, UserMessage } from './types.ts';

/** 提醒消息的 producer-owned source kind（区别于压缩日志消息的 plugin:dsh-plugin-om）。 */
export const PROGRESS_REMINDER_SOURCE_KIND = 'plugin:dsh-plugin-om:progress';

/** 提醒消息的 source。 */
export type ProgressReminderSource = {
  readonly kind: typeof PROGRESS_REMINDER_SOURCE_KIND;
  readonly form: 'instructions';
};

/** 提醒全文（含 system-reminder 包裹）。 */
export const PROGRESS_REMINDER_TEXT = [
  '<system-reminder>',
  'Narrate your progress while you work, not only when the task is finished.',
  '- Before your first tool call on a task, state your plan in one or two sentences.',
  '- After each meaningful chunk of work (a group of related tool calls, a finished investigation, a completed edit), briefly report what you found or did and what you will do next, then continue.',
  '- Do not narrate every individual tool call; one short note per chunk is enough.',
  '- Do not save all commentary for the final answer. The final answer summarizes outcomes.',
  'This reminder does not override system, developer, or direct user instructions.',
  '</system-reminder>',
].join('\n');

/** 构造一条新的提醒消息。 */
export function progressReminderMessage(): UserMessage {
  const source: ProgressReminderSource = {
    kind: PROGRESS_REMINDER_SOURCE_KIND,
    form: 'instructions',
  };
  return createUserMessage({
    content: [{ type: 'text', text: PROGRESS_REMINDER_TEXT }],
    source,
  });
}

/** 消息是否为当前文本的提醒。 */
function isCurrentReminder(
  source: { kind?: string },
  content: readonly { type: string; text?: string }[],
): boolean {
  return (
    source.kind === PROGRESS_REMINDER_SOURCE_KIND &&
    content.length === 1 &&
    content[0]?.type === 'text' &&
    content[0].text === PROGRESS_REMINDER_TEXT
  );
}

/**
 * 保证本 step 之后的消息列表中有一条当前提醒：本 step 已带上或表层已有则原样返回，
 * 否则在末尾追加。返回新数组，不修改入参。
 */
export function ensureProgressReminder(
  session: Session,
  messages: readonly UserMessage[],
): UserMessage[] {
  if (messages.some((message) => isCurrentReminder(message.source, message.content))) {
    return [...messages];
  }
  const events = session.snapshotEvents();
  for (const seq of session.surface.nodes) {
    const event = events[seq];
    if (
      event?.type === 'user/message' &&
      isCurrentReminder(event.data.source, event.data.content)
    ) {
      return [...messages];
    }
  }
  return [...messages, progressReminderMessage()];
}
