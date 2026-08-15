/**
 * 会话日志索引：消息索引（message_id → 消息事件，recall 按 message_id 定位区间），
 * 以及表层节点定位辅助。事件日志仅追加（被遮蔽的事件仍可读，recall 依赖此性质）。
 */
import type { MessageIndex, MessageNode, Session, SessionEvent } from './types.ts';

/**
 * 查找 seq 在表层节点序列中的下标（不在则返回 -1）。
 * 表层节点按日志顺序排列，用于压缩边界定位与遮蔽范围计算。
 */
export function surfaceIndexOf(nodes: readonly number[], seq: number): number {
  for (let i = 0; i < nodes.length; i += 1) if (nodes[i] === seq) return i;
  return -1;
}

/** 提取一条消息事件的 message_id（user/assistant/tool-result 消息均有稳定 id；其余事件无）。 */
export function messageIdOfEvent(event: SessionEvent | undefined): string | undefined {
  if (!event) return undefined;
  if (event.type === 'user/message') return String(event.data.id ?? '');
  if (event.type === 'assistant/message') return String(event.data.message.id ?? '');
  if (event.type === 'tool/result') return String(event.data.message.id ?? '');
  return undefined;
}

/** 消息索引：按日志顺序列出全部消息事件，并按 message_id 定位其在消息序列中的下标。 */
export function indexMessages(session: Session): MessageIndex {
  /** 按日志顺序的消息事件列表。 */
  const messages: MessageNode[] = [];
  /** message_id → 序列下标映射。 */
  const byId = new Map<string, number>();
  /** 会话全部事件。 */
  const events = session.events;
  for (let seq = 0; seq < events.length; seq += 1) {
    /** 当前待检查事件。 */
    const event = events[seq];
    if (!event) continue;
    if (
      event.type !== 'user/message' &&
      event.type !== 'assistant/message' &&
      event.type !== 'tool/result'
    )
      continue;
    /** 消息 id（缺失则跳过该事件）。 */
    const id = messageIdOfEvent(event);
    if (!id) continue;
    /** 本条消息在消息序列中的下标。 */
    const index = messages.length;
    messages.push({ seq, id, type: event.type });
    byId.set(id, index);
  }
  return { messages, byId };
}
