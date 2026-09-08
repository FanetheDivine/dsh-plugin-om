/**
 * 零依赖工具函数：文本呈现、主会话判定、路由解析等通用辅助（不 import 运行时包）。
 * 导出 isRecord / uuid / blocksToText / textCharCount / renderMessageText / toolArgsJson /
 * safeJson / appendCdataText / isMainSession / routedTarget。
 */
import type { Message } from '@deepseek-ai/dsh-llm';
import type { Document, Element } from '@xmldom/xmldom';
import type { Session } from './types.ts';

/** 判断值是否为普通对象（非 null、非数组）。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 生成 uuid：优先 crypto.randomUUID，回退为时间戳+随机串拼接。 */
export function uuid(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') return cryptoObj.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** 提取 content 数组中的纯文本块（type === 'text' 的 block.text 拼接）。 */
export function blocksToText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return '';
  const out: string[] = [];
  for (const block of blocks) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string')
      out.push(block.text);
  }
  return out.join('');
}

/** 消息内容的字符数：递归计入 text 块与 tool-result 内嵌文本。 */
export function textCharCount(message: Message | null | undefined): number {
  if (!message || !Array.isArray(message.content)) return 0;
  let total = 0;
  for (const block of message.content) {
    if (block.type === 'text') {
      total += block.text.length;
    } else if (block.type === 'tool-result') {
      total += blocksToText(block.content).length;
    }
  }
  return total;
}

/** 面向 recall 的完整消息呈现：text 原样；tool-call 展开（参数=代码）；tool-result 取文本。 */
export function renderMessageText(message: Message | null | undefined): string {
  if (!message || !Array.isArray(message.content)) return '';
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === 'text') {
      parts.push(block.text);
    } else if (block.type === 'tool-call') {
      parts.push(`[tool-call ${block.name} id=${String(block.id)}]
${toolArgsJson(block.arguments)}`);
    } else if (block.type === 'tool-result') {
      parts.push(blocksToText(block.content));
    }
  }
  return parts.join('\n');
}

/** 安全 JSON 序列化：序列化失败时退回 String 呈现。 */
export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * 工具调用参数的 JSON 文本（CDATA 内保持只有一层 JSON 转义）：
 * 字符串参数是模型产出的原始 JSON 串，原样返回（本身即合法 JSON，不再二次序列化）；
 * 其余结构 JSON.stringify 序列化一次。
 */
export function toolArgsJson(args: unknown): string {
  if (typeof args === 'string') return args;
  return safeJson(args);
}

/**
 * 向元素追加 CDATA 正文：正文统一以 CDATA 包裹（逐字原样，不做实体转义）。
 * 正文含 ]]> 时拆为相邻多个 CDATA 段，拼接后逐字还原原文，对读取方透明。
 */
export function appendCdataText(doc: Document, el: Element, text: string): void {
  const parts = text.split(']]>');
  for (let i = 0; i < parts.length; i += 1) {
    if (i === 0) {
      el.appendChild(doc.createCDATASection(parts[0] ?? ''));
    } else {
      // ]]> 编码为相邻两段 CDATA：<![CDATA[]]]]><![CDATA[>…]]>，拼接还原为 ]]>
      el.appendChild(doc.createCDATASection(']]'));
      el.appendChild(doc.createCDATASection(`>${parts[i] ?? ''}`));
    }
  }
}

/** 主会话判定：subagent 会话 header.origin === 'subagent'。 */
export function isMainSession(session: Session): boolean {
  return session.header?.origin !== 'subagent';
}

/** 会话路由目标：provider + model。 */
export type RoutedTarget = { provider: string; model: string };

/** 解析会话路由目标（provider/model），未路由时返回 undefined。 */
export function routedTarget(session: Session): RoutedTarget | undefined {
  try {
    const config = session.requestHeader()?.config;
    if (config?.provider && config.model) return { provider: config.provider, model: config.model };
  } catch {
    /* 未路由则返回 undefined */
  }
  return undefined;
}
