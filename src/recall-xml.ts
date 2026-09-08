/**
 * 完整消息的 XML 条目渲染：recall / recall-semantic 的输出条目形态。
 * 每条完整消息渲染为一个 XML 元素，正文统一以 CDATA 包裹（逐字原样，不做实体转义与
 * 再次序列化），从构建源头避免多层转义：
 * - user → <user_message index>，正文 CDATA，图片等非文本块为 XML 注释
 * - sys → <sys index type>，无正文时自闭合（与压缩日志的 sys 条目同形态）
 * - assistant 文本 → <assistant index type="text">，正文 CDATA
 * - toolcall → <assistant index type="toolcall" tool-name callId>，内嵌 <tool-args>
 *   （合法 JSON，仅一层 JSON 转义）与 <tool-result>（工具返回正文）两个 CDATA 子元素
 * 导出 RenderCompleteMessageXmlOptions / renderCompleteMessageXml / xmlCommentText。
 */

import type { Document, Element } from '@xmldom/xmldom';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import {
  collectImageRefs,
  type PrunerLike,
  renderCompleteMessageParts,
  toolCallBlockOf,
  toolResultMessageOf,
} from './log-index.ts';
import { type ImageRefValue, imageNote } from './recall-output.ts';
import type { CompleteMessage, Session } from './types.ts';
import { appendCdataText, renderMessageText, toolArgsJson } from './utils.ts';

/** 渲染选项：pruner 裁剪超大工具结果；fallbackText 为主渲染失败时的回退正文。 */
export type RenderCompleteMessageXmlOptions = {
  pruner?: PrunerLike | undefined;
  fallbackText?: string;
};

/** 静默 DOMParser：非致命解析问题不刷 console。 */
function newQuietParser(): DOMParser {
  return new DOMParser({ onError: () => {} });
}

/** XML 注释文本：注释内不允许连续连字符，`--` 统一替换为破折号。 */
export function xmlCommentText(text: string): string {
  return text.replace(/--/g, '——');
}

/** 向元素追加图片附件注释（每张图片一条，附在元素正文之后）。 */
function appendImageComments(doc: Document, el: Element, images: readonly ImageRefValue[]): void {
  for (const ref of images) {
    el.appendChild(doc.createComment(` ${xmlCommentText(imageNote(ref))} `));
  }
}

/** 正文有内容时以 CDATA 追加，无内容时不追加（元素自然自闭合或仅含注释）。 */
function appendBodyText(doc: Document, el: Element, text: string): void {
  if (text !== '') appendCdataText(doc, el, text);
}

/** toolcall 完整消息的元素：<assistant type="toolcall"> 内嵌 <tool-args> / <tool-result>。 */
function toolcallElement(
  doc: Document,
  session: Session,
  cm: CompleteMessage,
  pruner: PrunerLike | undefined,
  images: ImageRefValue[],
): Element {
  const el = doc.createElement('assistant');
  el.setAttribute('index', String(cm.index));
  el.setAttribute('type', 'toolcall');
  const call = toolCallBlockOf(session, cm);
  const toolName = call === undefined ? '' : String(call.name ?? '');
  if (toolName !== '') el.setAttribute('tool-name', toolName);
  if (cm.callId) el.setAttribute('callId', cm.callId);
  if (call) {
    const args = doc.createElement('tool-args');
    appendCdataText(doc, args, toolArgsJson(call.arguments));
    el.appendChild(args);
  }
  const resultMessage = toolResultMessageOf(session, cm, pruner);
  if (resultMessage && Array.isArray(resultMessage.content)) {
    collectImageRefs(resultMessage.content, images);
    const resultText = renderMessageText(resultMessage);
    if (resultText.trim() !== '') {
      const result = doc.createElement('tool-result');
      appendCdataText(doc, result, resultText);
      el.appendChild(result);
    }
  }
  appendImageComments(doc, el, images);
  return el;
}

/** 按完整消息类别构建元素（user / sys / assistant 文本条目复用 parts 渲染）。 */
function buildElement(
  doc: Document,
  session: Session,
  cm: CompleteMessage,
  pruner: PrunerLike | undefined,
  images: ImageRefValue[],
): Element {
  if (cm.type === 'toolcall') return toolcallElement(doc, session, cm, pruner, images);
  const parts = renderCompleteMessageParts(session, cm, pruner);
  images.push(...parts.images);
  if (cm.type === 'sys') {
    const el = doc.createElement('sys');
    el.setAttribute('index', String(cm.index));
    if (cm.kind !== undefined) el.setAttribute('type', cm.kind);
    appendBodyText(doc, el, parts.text);
    appendImageComments(doc, el, parts.images);
    return el;
  }
  const el = doc.createElement(cm.type === 'user' ? 'user_message' : 'assistant');
  el.setAttribute('index', String(cm.index));
  if (cm.type === 'assistant') el.setAttribute('type', 'text');
  appendBodyText(doc, el, parts.text);
  appendImageComments(doc, el, parts.images);
  return el;
}

/** 主渲染失败时的回退元素：按完整消息类别输出最简形态，正文为回退文本。 */
function fallbackElement(doc: Document, cm: CompleteMessage, text: string): Element {
  if (cm.type === 'sys') {
    const el = doc.createElement('sys');
    el.setAttribute('index', String(cm.index));
    if (cm.kind !== undefined) el.setAttribute('type', cm.kind);
    return el;
  }
  const el = doc.createElement(cm.type === 'user' ? 'user_message' : 'assistant');
  el.setAttribute('index', String(cm.index));
  if (cm.type !== 'user') el.setAttribute('type', cm.type === 'toolcall' ? 'toolcall' : 'text');
  appendBodyText(doc, el, text);
  return el;
}

/**
 * 渲染一条完整消息为 XML 条目（序列化后的字符串）与其携带的图片附件元数据。
 * 主渲染失败且提供 fallbackText 时降级为最简元素；两者皆不可用时向上抛出，
 * 由调用方决定跳过或回退。
 */
export function renderCompleteMessageXml(
  session: Session,
  cm: CompleteMessage,
  options: RenderCompleteMessageXmlOptions = {},
): { xml: string; images: ImageRefValue[] } {
  const images: ImageRefValue[] = [];
  const doc = newQuietParser().parseFromString('<root />', 'text/xml');
  let el: Element;
  try {
    el = buildElement(doc, session, cm, options.pruner, images);
  } catch (error) {
    if (options.fallbackText === undefined) throw error;
    images.length = 0;
    el = fallbackElement(doc, cm, options.fallbackText);
  }
  return { xml: new XMLSerializer().serializeToString(el), images };
}
