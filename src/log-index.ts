/**
 * 会话日志索引：完整消息索引与渲染。
 * 导出 indexCompleteMessages（完整消息四类折叠索引，recall 与摘要共用同一套编号）、
 * indexMessages / surfaceIndexOf / messageIdOfEvent（消息级定位辅助）、
 * collectImageRefs / toolResultMessageOf / renderToolResultText / renderCompleteMessageParts /
 * renderCompleteMessage（完整消息渲染与图片附件收集）。事件日志仅追加（被遮蔽的事件仍可读，
 * recall 依赖此性质）。
 *
 * 完整消息分四类：user（用户消息）、sys（系统消息，压缩日志中以 <sys> 空块表示）、
 * assistant（模型输出文本）、toolcall（单个工具调用及其结果，result 按 callId 匹配并入）。
 * index 从 0 起、按日志顺序递增、只追加不重排（压缩后旧摘要条目引用的 index 仍然有效）。
 */
import { isPluginOwnedSource } from './constants.ts';
import type { ImageRefValue } from './recall-output.ts';
import type {
  CompleteMessage,
  Message,
  MessageIndex,
  MessageNode,
  Session,
  SessionEvent,
} from './types.ts';
import { isRecord, renderMessageText, safeJson } from './utils.ts';

/** 工具结果裁剪器结构（tool-result-pruner；超大结果渲染前裁剪）。 */
export type PrunerLike = { pruneContent?: (blocks: readonly unknown[]) => unknown[] | null };

/** 查找 seq 在表层节点序列中的下标（不在则返回 -1）。 */
export function surfaceIndexOf(nodes: readonly number[], seq: number): number {
  for (let i = 0; i < nodes.length; i += 1) if (nodes[i] === seq) return i;
  return -1;
}

/** 提取一条消息事件的 message_id（仅 user/assistant/tool-result 消息事件有）。 */
export function messageIdOfEvent(event: SessionEvent | undefined): string | undefined {
  if (!event) return undefined;
  if (event.type === 'user/message') return String(event.data.id ?? '');
  if (event.type === 'assistant/message') return String(event.data.message.id ?? '');
  if (event.type === 'tool/result') return String(event.data.message.id ?? '');
  return undefined;
}

/** 消息索引：按日志顺序列出全部消息事件，并按 message_id 定位下标。 */
export function indexMessages(session: Session): MessageIndex {
  const messages: MessageNode[] = [];
  const byId = new Map<string, number>();
  const events = session.events;
  for (let seq = 0; seq < events.length; seq += 1) {
    const event = events[seq];
    if (!event) continue;
    if (
      event.type !== 'user/message' &&
      event.type !== 'assistant/message' &&
      event.type !== 'tool/result'
    )
      continue;
    const id = messageIdOfEvent(event);
    if (!id) continue;
    const index = messages.length;
    messages.push({ seq, id, type: event.type });
    byId.set(id, index);
  }
  return { messages, byId };
}

/**
 * 完整消息索引：按日志顺序把消息事件折叠为完整消息序列（四类，见文件头）。
 * 工具调用结果按 source.callId 匹配其 tool-call 并入该条；未匹配的 result 独立成条（防御）。
 * 本插件自产消息不占位；压缩在 agent/pre-step 触发（call-result 完备），不存在未闭合调用。
 */
export function indexCompleteMessages(session: Session): CompleteMessage[] {
  const cms: CompleteMessage[] = [];
  const pending = new Map<string, CompleteMessage>();
  const events = session.events;
  for (let seq = 0; seq < events.length; seq += 1) {
    const event = events[seq];
    if (!event) continue;
    if (event.type === 'user/message') {
      // kind:user 为用户消息，其余为系统消息；本插件自产消息不占位
      const source = event.data.source as { kind?: string; plugin?: string } | undefined;
      if (isPluginOwnedSource(source)) continue;
      if (source?.kind === 'user') {
        cms.push({ index: cms.length, type: 'user', seqs: [seq] });
      } else {
        cms.push({
          index: cms.length,
          type: 'sys',
          seqs: [seq],
          ...(source?.kind === undefined ? {} : { kind: source.kind }),
        });
      }
    } else if (event.type === 'assistant/message') {
      const message = event.data.message;
      if (!message || !Array.isArray(message.content)) continue;
      // 文本与工具调用拆开：文本占一条，每个 tool-call（及其结果）各占一条
      let hasText = false;
      for (const block of message.content) {
        if (block.type === 'text') {
          hasText = true;
          break;
        }
      }
      if (hasText) cms.push({ index: cms.length, type: 'assistant', seqs: [seq] });
      for (const block of message.content) {
        if (block.type !== 'tool-call') continue;
        const callId = String(block.id ?? '');
        const cm: CompleteMessage = {
          index: cms.length,
          type: 'toolcall',
          seqs: [seq],
          ...(callId === '' ? {} : { callId }),
        };
        cms.push(cm);
        if (callId !== '') pending.set(callId, cm);
      }
    } else if (event.type === 'tool/result') {
      const source = event.data.message?.source as { callId?: unknown } | undefined;
      const callId = String(source?.callId ?? '');
      const cm = callId === '' ? undefined : pending.get(callId);
      if (cm) {
        cm.seqs.push(seq);
        pending.delete(callId);
      } else {
        cms.push({
          index: cms.length,
          type: 'toolcall',
          seqs: [seq],
          ...(callId === '' ? {} : { callId }),
        });
      }
    }
  }
  return cms;
}
/**
 * 递归收集内容块中的图片附件元数据（recall 输出保留图片用）：
 * image 块按附件元数据收集（字段不全则忽略）；tool-result 块递归收集其 content。
 */
export function collectImageRefs(content: unknown, out: ImageRefValue[]): void {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'image') {
      const a = block.attachment;
      if (
        isRecord(a) &&
        typeof a.attachmentId === 'string' &&
        a.attachmentId !== '' &&
        typeof a.mediaType === 'string' &&
        typeof a.bytes === 'number' &&
        Number.isFinite(a.bytes) &&
        typeof a.width === 'number' &&
        Number.isFinite(a.width) &&
        typeof a.height === 'number' &&
        Number.isFinite(a.height)
      ) {
        out.push({
          attachmentId: a.attachmentId,
          mediaType: a.mediaType,
          bytes: a.bytes,
          width: a.width,
          height: a.height,
          ...(typeof a.name === 'string' && a.name !== '' ? { name: a.name } : {}),
        });
      }
    } else if (block.type === 'tool-result') {
      collectImageRefs(block.content, out);
    }
  }
}

/**
 * 取 toolcall 完整消息的 tool/result 消息（超大结果经 pruner 裁剪）：
 * 结果文本渲染与 <skill> 条目正文共用；非 toolcall 或无配对 result 时返回 undefined。
 */
export function toolResultMessageOf(
  session: Session,
  cm: CompleteMessage,
  pruner?: PrunerLike,
): Message | undefined {
  if (cm.type !== 'toolcall') return undefined;
  const resultSeq = cm.seqs[1];
  const resultEvent = resultSeq === undefined ? undefined : session.events[resultSeq];
  if (resultEvent?.type !== 'tool/result') return undefined;
  const message = session.deriveEventMessage(resultEvent);
  if (!message) return undefined;
  const pruned = pruner?.pruneContent?.(message.content);
  return pruned ? ({ ...message, content: pruned } as Message) : message;
}

/** 渲染 toolcall 完整消息的工具返回文本（仅 result 内容；无配对 result 时为空串）。 */
export function renderToolResultText(
  session: Session,
  cm: CompleteMessage,
  pruner?: PrunerLike,
): string {
  const message = toolResultMessageOf(session, cm, pruner);
  return message ? renderMessageText(message) : '';
}

/** 渲染一条完整消息为「文本 + 图片」（recall / recall-semantic 输出用）：
 * user/sys 取消息原文，assistant 取文本块，toolcall 为调用块 + 结果文本
 * （pruner 裁剪超大结果）；同时收集该条完整消息携带的图片附件（含 tool-result 嵌套，
 * pruner 裁剪掉的图片不收集）。
 */
export function renderCompleteMessageParts(
  session: Session,
  cm: CompleteMessage,
  pruner?: PrunerLike,
): { text: string; images: ImageRefValue[] } {
  const images: ImageRefValue[] = [];
  if (cm.type === 'user' || cm.type === 'sys') {
    const seq = cm.seqs[0];
    const event = seq === undefined ? undefined : session.events[seq];
    const message = event ? session.deriveEventMessage(event) : null;
    if (message && Array.isArray(message.content)) collectImageRefs(message.content, images);
    return { text: message ? renderMessageText(message) : '', images };
  }
  if (cm.type === 'assistant') {
    const seq = cm.seqs[0];
    const event = seq === undefined ? undefined : session.events[seq];
    const message = event ? session.deriveEventMessage(event) : null;
    if (!message || !Array.isArray(message.content)) return { text: '', images };
    collectImageRefs(message.content, images);
    const texts: string[] = [];
    for (const block of message.content) {
      if (block.type === 'text') texts.push(String(block.text));
    }
    return { text: texts.join('\n'), images };
  }
  // toolcall：调用参数 + 结果文本
  const parts: string[] = [];
  const callSeq = cm.seqs[0];
  const callEvent = callSeq === undefined ? undefined : session.events[callSeq];
  if (callEvent?.type === 'assistant/message') {
    const message = session.deriveEventMessage(callEvent);
    if (message && Array.isArray(message.content)) {
      let call: { name?: unknown; id?: unknown; arguments?: unknown } | undefined;
      for (const block of message.content) {
        if (block.type === 'tool-call' && String(block.id ?? '') === (cm.callId ?? '')) {
          call = block;
          break;
        }
      }
      if (call) {
        parts.push(
          `[tool-call ${String(call.name ?? '')} id=${String(call.id ?? '')}]\n${safeJson(call.arguments)}`,
        );
      }
    }
  }
  const resultMessage = toolResultMessageOf(session, cm, pruner);
  if (resultMessage && Array.isArray(resultMessage.content)) {
    collectImageRefs(resultMessage.content, images);
    const text = renderMessageText(resultMessage);
    if (text.trim() !== '') parts.push(`[result]\n${text}`);
  }
  return { text: parts.join('\n'), images };
}

/** 渲染一条完整消息的文本（压缩输入与语义嵌入共用）：renderCompleteMessageParts 的纯文本投影。 */
export function renderCompleteMessage(
  session: Session,
  cm: CompleteMessage,
  pruner?: PrunerLike,
): string {
  return renderCompleteMessageParts(session, cm, pruner).text;
}
