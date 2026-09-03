/**
 * 会话日志索引：完整消息索引（index 定位完整消息，recall 与摘要共用同一套编号），
 * 以及表层节点定位辅助。事件日志仅追加（被遮蔽的事件仍可读，recall 依赖此性质）。
 *
 * 完整消息是摘要日志与 recall 共用的定位单位，分四类：
 *  - user：用户消息（user/message 中 source.kind === 'user'）占一条；
 *  - sys：系统消息（user/message 中其余 source.kind 的部分，如宿主注入的上下文）
 *    占一条；压缩日志中以 <sys type="KIND" index="N"> 空块表示（内容不进入输入）；
 *  - assistant：模型输出文本（assistant/message 中的文本块）占一条；
 *  - toolcall：单个工具调用及其结果占一条（同一条 AI 消息里的文本与工具调用拆开，
 *    tool/result 按 source.callId 匹配其 tool-call；未匹配的 result 独立成条，防御）。
 * 本插件自产的压缩日志消息（source.kind === 'plugin' 且 plugin 为本插件标识）不占 index。
 * index 从 0 起、按日志顺序递增、只追加不重排 → 会话内全局稳定，
 * 压缩后旧摘要条目引用的 index 仍然有效。
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

/**
 * 完整消息索引：按日志顺序把消息事件折叠为完整消息序列（四类，见文件头）。
 * 工具调用结果按 source.callId 匹配其 tool-call 并入该条；未匹配的 result 独立成条（防御）。
 * 插件在 agent/pre-step 触发压缩（日志 call-result 完备），因此压缩时不存在未闭合的
 * tool-call；索引对未闭合调用不设特殊处理。
 */
export function indexCompleteMessages(session: Session): CompleteMessage[] {
  /** 完整消息序列（index = 数组下标，0 起）。 */
  const cms: CompleteMessage[] = [];
  /** 等待结果的 toolcall 完整消息（callId → cm）。 */
  const pending = new Map<string, CompleteMessage>();
  /** 会话全部事件（仅追加）。 */
  const events = session.events;
  for (let seq = 0; seq < events.length; seq += 1) {
    /** 当前待检查事件。 */
    const event = events[seq];
    if (!event) continue;
    if (event.type === 'user/message') {
      // 本插件自产消息（<history> 压缩日志块等）不占位；kind:user 为用户消息，其余为系统消息
      /** 事件 source（区分用户消息与宿主注入/插件消息）。 */
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
      /** 助手消息（含文本与 tool-call 块）。 */
      const message = event.data.message;
      if (!message || !Array.isArray(message.content)) continue;
      // 文本与工具调用拆开：文本占一条，每个 tool-call（及其结果）各占一条
      /** 是否存在文本块（有则先产出 assistant 条）。 */
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
        /** 工具调用 id（匹配 result 用）。 */
        const callId = String(block.id ?? '');
        /** 本调用对应的完整消息（结果随后并入）。 */
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
      /** 结果消息的 source（callId 关联调用）。 */
      const source = event.data.message?.source as { callId?: unknown } | undefined;
      /** 关联的调用 id。 */
      const callId = String(source?.callId ?? '');
      /** 匹配到的 toolcall 完整消息（无则独立成条）。 */
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
 * 递归收集内容块中的图片附件元数据（recall / recall-semantic 输出保留图片用）：
 *  - image 块：attachment 携带持久元数据（宿主 admission 校验过的 ImageAttachmentRef），
 *    字段齐全时收集为无损 JSON 引用（不含图片字节）；
 *  - tool-result 块：递归收集其 content（工具结果可嵌套图片，如 read_image 的结果）；
 *  - 其余块忽略；字段不全的 image 块忽略（防御）。
 */
export function collectImageRefs(content: unknown, out: ImageRefValue[]): void {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'image') {
      /** image 块的附件元数据。 */
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
 * 渲染一条完整消息为「文本 + 图片」（recall / recall-semantic 输出用）。
 * 文本部分与 renderCompleteMessage 一致：
 *  - user / sys：消息原文；
 *  - assistant：仅文本块；
 *  - toolcall：调用块（工具名 + 参数）+ 结果文本（pruner 裁剪超大结果）。
 * 另递归收集该条完整消息携带的图片附件：user/sys/assistant 的顶层 image 块、
 * toolcall 结果 content 内的图片（含 tool-result 嵌套）；pruner 裁剪掉的图片不收集。
 */
export function renderCompleteMessageParts(
  session: Session,
  cm: CompleteMessage,
  pruner?: PrunerLike,
): { text: string; images: ImageRefValue[] } {
  /** 该条完整消息携带的图片（按出现顺序）。 */
  const images: ImageRefValue[] = [];
  if (cm.type === 'user' || cm.type === 'sys') {
    /** 用户/系统消息事件（seq 缺失则无法渲染）。 */
    const seq = cm.seqs[0];
    const event = seq === undefined ? undefined : session.events[seq];
    /** 派生的消息对象。 */
    const message = event ? session.deriveEventMessage(event) : null;
    if (message && Array.isArray(message.content)) collectImageRefs(message.content, images);
    return { text: message ? renderMessageText(message) : '', images };
  }
  if (cm.type === 'assistant') {
    /** 助手消息事件（seq 缺失则无法渲染）。 */
    const seq = cm.seqs[0];
    const event = seq === undefined ? undefined : session.events[seq];
    /** 派生的消息对象。 */
    const message = event ? session.deriveEventMessage(event) : null;
    if (!message || !Array.isArray(message.content)) return { text: '', images };
    collectImageRefs(message.content, images);
    /** 文本块拼接缓冲。 */
    const texts: string[] = [];
    for (const block of message.content) {
      if (block.type === 'text') texts.push(String(block.text));
    }
    return { text: texts.join('\n'), images };
  }
  // toolcall：调用参数 + 结果文本
  /** 渲染缓冲。 */
  const parts: string[] = [];
  /** 承载调用块的 assistant 事件（seq 缺失则跳过调用块）。 */
  const callSeq = cm.seqs[0];
  const callEvent = callSeq === undefined ? undefined : session.events[callSeq];
  if (callEvent?.type === 'assistant/message') {
    /** 助手消息对象（取对应调用块）。 */
    const message = session.deriveEventMessage(callEvent);
    if (message && Array.isArray(message.content)) {
      /** 匹配的 tool-call 块。 */
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
  /** 结果事件 seq（无则调用未闭合）。 */
  const resultSeq = cm.seqs[1];
  const resultEvent = resultSeq === undefined ? undefined : session.events[resultSeq];
  if (resultEvent?.type === 'tool/result') {
    /** 结果消息对象（pruner 裁剪超大内容后渲染）。 */
    let message = session.deriveEventMessage(resultEvent);
    if (message && pruner?.pruneContent) {
      /** 裁剪后的内容块。 */
      const pruned = pruner.pruneContent(message.content);
      if (pruned) message = { ...message, content: pruned } as Message;
    }
    if (message && Array.isArray(message.content)) collectImageRefs(message.content, images);
    /** 结果文本。 */
    const text = message ? renderMessageText(message) : '';
    if (text.trim() !== '') parts.push(`[result]\n${text}`);
  }
  return { text: parts.join('\n'), images };
}

/**
 * 渲染一条完整消息的文本（压缩输入 / new 模式输入共用）：
 * renderCompleteMessageParts 的纯文本投影（图片附件不进入文本）。
 */
export function renderCompleteMessage(
  session: Session,
  cm: CompleteMessage,
  pruner?: PrunerLike,
): string {
  return renderCompleteMessageParts(session, cm, pruner).text;
}
