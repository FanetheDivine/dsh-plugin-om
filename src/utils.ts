/**
 * 零依赖工具函数：不 import 任何运行时包，保证单文件打包与任意位置挂载。
 * 主要服务于配置校验、文本呈现与主会话判定。
 */
import type { Message } from '@deepseek-ai/dsh-llm';
import type { Session } from './types.ts';

/** 判断值是否为普通对象：typeof object 且非 null 且非数组（类型收窄用）。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 抛出带插件前缀的错误（never 返回：调用后控制流终止）。 */
export function fail(message: string): never {
  throw new Error(`dsh-plugin-om: ${message}`);
}

/** 数值配置项的取值约束（assertNumber 的可选参数）。 */
export type NumberConstraints = {
  /** 允许的最小值（含），默认 0。 */
  min?: number;
  /** 允许的最大值（含），默认 Infinity。 */
  max?: number;
  /** 是否必须为整数，默认 false。 */
  integer?: boolean;
};

/**
 * 校验配置数值：必须是有限数且在 [min, max] 内（可选整数约束），
 * 不满足时抛出带插件前缀的错误。
 */
export function assertNumber(
  name: string,
  value: unknown,
  { min = 0, max = Infinity, integer = false }: NumberConstraints = {},
): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    fail(`config ${name} must be a finite number in [${min}, ${max}]`);
  }
  if (integer && !Number.isInteger(value)) fail(`config ${name} must be an integer`);
}

/** 生成 uuid：优先 crypto.randomUUID，回退为时间戳+随机串拼接（保证唯一性）。 */
export function uuid(): string {
  /** 全局 crypto 对象（提供 randomUUID 的现代环境才存在）。 */
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') return cryptoObj.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** 提取 content 数组中的纯文本块（type === 'text' 的 block.text 拼接）。 */
export function blocksToText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return '';
  /** 拼接结果缓冲区。 */
  const out: string[] = [];
  for (const block of blocks) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string')
      out.push(block.text);
  }
  return out.join('');
}

/** 面向 recall 的完整消息呈现：text 原样；tool-call 展开（参数=代码）；tool-result 取文本。 */
export function renderMessageText(message: Message | null | undefined): string {
  if (!message || !Array.isArray(message.content)) return '';
  /** 各内容块呈现后的拼接缓冲区。 */
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === 'text') {
      parts.push(block.text);
    } else if (block.type === 'tool-call') {
      parts.push(`[tool-call ${block.name} id=${String(block.id)}]
${safeJson(block.arguments)}`);
    } else if (block.type === 'tool-result') {
      parts.push(blocksToText(block.content));
    }
  }
  return parts.join('\n');
}

/** 安全 JSON 序列化：序列化失败时退回 String 呈现（避免渲染异常）。 */
export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** 主会话判定：subagent 会话 header.origin === 'subagent'（压缩/recall 仅主会话生效）。 */
export function isMainSession(session: Session): boolean {
  return session.header?.origin !== 'subagent';
}

/** 会话路由目标：provider + model（压缩合并调用与容量查询使用）。 */
export type RoutedTarget = { provider: string; model: string };

/** 解析会话路由目标（provider/model），未路由时返回 undefined。 */
export function routedTarget(session: Session): RoutedTarget | undefined {
  try {
    /** 会话请求头中的路由配置。 */
    const config = session.requestHeader()?.config;
    if (config?.provider && config.model) return { provider: config.provider, model: config.model };
  } catch {
    /* 未路由则返回 undefined */
  }
  return undefined;
}
