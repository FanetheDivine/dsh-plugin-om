/**
 * Claude thinking 签名前缀绑定修复：Claude 的 thinking 签名绑定其前全部内容，OM 替换后
 * 保留尾部中压缩前生成的签名失效，请求返回 400。发出请求前剥离这些消息的 reasoning。
 * 导出 staleAssistantIds / isAnthropicSigned / stripReasoning / sanitizeMessages /
 * registerThinkingBinding。
 *
 * - 分界：seq 最大的 OM 消息（最新一次替换检查点）。观察压缩时其位于表层最后；
 *   反思提交的归档块追加在日志尾部但表层位于保留的旧 H 块之前，故按 seq 选取
 * - 过期：分界之后 seq 小于分界的 assistant/message，即生成于该次替换之前
 * - 仅剥离 Anthropic 签名：replayState api 为 Anthropic 协议、模型名含 claude-、
 *   且带签名或 redacted 的 reasoning；其余模型的签名校验不绑定前缀，保持原样
 */
import {
  type AssistantMessage,
  freezeMessage,
  type GenerateOptions,
  isAgentLoopRequest,
  markAgentLoopRequest,
  type RequestMessage,
} from '@deepseek-ai/dsh-llm';
import { PLUGIN_SOURCE_KIND } from './constants.ts';
import type { PluginLogger } from './logger.ts';
import type { Context, Session } from './types.ts';

/** 签名绑定前缀的 Anthropic 协议（pi-ai replayState.response.api）。 */
const ANTHROPIC_APIS: ReadonlySet<string> = new Set([
  'anthropic-messages',
  'bedrock-converse-stream',
]);

/** Claude 模型名：匹配 claude-xx，兼容 anthropic/claude-xx 与 us.anthropic.claude-xx。 */
const CLAUDE_MODEL = /\bclaude-/i;

/** 判定 JSON 值为普通对象（replayState 为宿主声明的 unknown，须逐层收窄）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 返回前缀已被最新 OM 消息改写的 assistant 消息 id；无 OM 消息时为空。 */
export function staleAssistantIds(session: Session): Set<string> {
  const stale = new Set<string>();
  const events = session.snapshotEvents();
  const nodes = session.surface.nodes;
  let boundary = -1;
  let boundarySeq = -1;
  for (let i = 0; i < nodes.length; i += 1) {
    const seq = nodes[i];
    if (seq === undefined) continue;
    const event = events[seq];
    if (
      event?.type === 'user/message' &&
      event.data.source?.kind === PLUGIN_SOURCE_KIND &&
      seq > boundarySeq
    ) {
      boundary = i;
      boundarySeq = seq;
    }
  }
  if (boundarySeq < 0) return stale;
  for (const seq of nodes.slice(boundary + 1)) {
    const event = events[seq];
    if (event?.type === 'assistant/message' && seq < boundarySeq) stale.add(event.data.message.id);
  }
  return stale;
}

/** 判定 assistant 消息带 Claude 经 Anthropic 协议签名的 reasoning。 */
export function isAnthropicSigned(message: AssistantMessage): boolean {
  const { model, replayState } = message.source;
  if (!CLAUDE_MODEL.test(model) || !isRecord(replayState)) return false;
  const { response, blocks } = replayState;
  if (!isRecord(response) || typeof response.api !== 'string') return false;
  if (!ANTHROPIC_APIS.has(response.api) || !Array.isArray(blocks)) return false;
  return blocks.some(
    (block) =>
      isRecord(block) &&
      block.type === 'reasoning' &&
      ((typeof block.thinkingSignature === 'string' && block.thinkingSignature.length > 0) ||
        block.redacted === true),
  );
}

/** 去掉 reasoning 块与 replayState，保留 text 与 tool-call；剥离后无内容返回 undefined。 */
export function stripReasoning(message: AssistantMessage): AssistantMessage | undefined {
  const content = message.content.filter((block) => block.type !== 'reasoning');
  if (content.length === 0) return undefined;
  const { provider, model } = message.source;
  return freezeMessage({ ...message, content, source: { kind: 'model', provider, model } });
}

/** 剥离过期消息的 Anthropic 签名 reasoning；无改动返回 undefined。 */
export function sanitizeMessages(
  session: Session,
  messages: readonly RequestMessage[],
): RequestMessage[] | undefined {
  const stale = staleAssistantIds(session);
  if (stale.size === 0) return undefined;
  let changed = false;
  const result: RequestMessage[] = [];
  for (const message of messages) {
    if (message.role === 'assistant' && stale.has(message.id) && isAnthropicSigned(message)) {
      changed = true;
      const stripped = stripReasoning(message);
      if (stripped !== undefined) result.push(stripped);
      continue;
    }
    result.push(message);
  }
  return changed ? result : undefined;
}

/**
 * 注册前置 llm/stream 中间件：会话请求需剥离时以新 options 重新调用 llm.stream，
 * 保留 agent loop 标记；重新进入的请求直接放行。辅助调用（purpose）不处理。
 */
export function registerThinkingBinding(ctx: Context, logger: PluginLogger): void {
  /** 已剥离并重新发出的请求，再次进入时直接放行。 */
  const rewritten = new WeakSet<GenerateOptions>();
  ctx.on(
    'llm/stream',
    (options, next) => {
      if (rewritten.has(options) || options.sessionId === undefined) return next();
      if (options.purpose !== undefined) return next();
      const session = ctx.sessions.get(options.sessionId);
      if (session === undefined) return next();
      let messages: RequestMessage[] | undefined;
      try {
        messages = sanitizeMessages(session, options.messages);
      } catch (error) {
        logger.warn(
          `thinking 签名剥离失败，按原请求发送: ${error instanceof Error ? error.message : String(error)}`,
        );
        return next();
      }
      if (messages === undefined) return next();
      const request: GenerateOptions = { ...options, messages };
      if (isAgentLoopRequest(options)) markAgentLoopRequest(request);
      rewritten.add(request);
      logger.step(`剥离压缩前生成的 Claude thinking 签名后重发请求（会话 ${session.id}）`);
      return ctx.llm.stream(request);
    },
    { prepend: true },
  );
}
