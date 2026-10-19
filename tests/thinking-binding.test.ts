// thinking 签名前缀绑定修复：过期判定、Anthropic 签名识别与 reasoning 剥离。
import {
  type AssistantMessage,
  type GenerateOptions,
  isAgentLoopRequest,
  markAgentLoopRequest,
  type RequestMessage,
} from '@deepseek-ai/dsh-llm';
import { describe, expect, it, vi } from 'vitest';
import { apply } from '../src/index.ts';
import {
  isAnthropicSigned,
  sanitizeMessages,
  staleAssistantIds,
  stripReasoning,
} from '../src/thinking-binding.ts';
import type { Session, SessionEvent } from '../src/types.ts';
import {
  archivedHistoryMessage,
  historyMessage,
  makeCtx,
  makeMessage,
  makeSession,
  systemMessageEvent,
  textBlock,
  toolCallBlock,
} from './helpers.ts';

interface AssistantOptions {
  model?: string;
  api?: string;
  signature?: string;
  redacted?: boolean;
  withText?: boolean;
}

/** 构造带 reasoning 的 assistant 消息，replayState 与 pi-ai v2 信封同构。 */
function assistant(id: string, options: AssistantOptions = {}): AssistantMessage {
  const {
    model = 'claude-opus-5',
    api = 'anthropic-messages',
    signature = 'sig-abc',
    redacted,
    withText = true,
  } = options;
  const content = [
    { type: 'reasoning', text: '思考过程' },
    ...(withText ? [textBlock('结论'), toolCallBlock(`call-${id}`, 'run', '{}')] : []),
  ];
  const blocks = content.map((block) =>
    block.type === 'reasoning'
      ? {
          type: 'reasoning',
          ...(signature === '' ? {} : { thinkingSignature: signature }),
          ...(redacted === undefined ? {} : { redacted }),
        }
      : { type: block.type },
  );
  return makeMessage({
    role: 'assistant',
    id,
    content,
    source: {
      kind: 'model',
      provider: 'gateway',
      model,
      replayState: {
        response: {
          kind: 'pi-ai',
          version: 2,
          api,
          provider: 'gateway',
          model,
          stopReason: 'stop',
        },
        blocks,
      },
    },
  }) as unknown as AssistantMessage;
}

/** 包装为 assistant/message 表层事件。 */
function assistantEvent(message: AssistantMessage): SessionEvent {
  return {
    type: 'assistant/message',
    surfaceOp: 'append',
    data: { turn: 1, step: 1, message },
  } as unknown as SessionEvent;
}

/** 用户消息事件。 */
function userEvent(text: string): SessionEvent {
  return {
    type: 'user/message',
    data: makeMessage({ content: [textBlock(text)] }),
  } as unknown as SessionEvent;
}

/**
 * 会话：sys(0) user(1) A1(2) user(3) A2(4) history(5) A3(6)；history 替换 user(1)，
 * reflect 时再追加 history(7) 替换 history(5)。
 */
function compactedSession(
  extra: Partial<Record<'a1' | 'a2' | 'a3', AssistantMessage>> = {},
  reflect = false,
) {
  const a1 = extra.a1 ?? assistant('a1');
  const a2 = extra.a2 ?? assistant('a2');
  const a3 = extra.a3 ?? assistant('a3');
  const events = [
    systemMessageEvent('系统提示词'),
    userEvent('任务'),
    assistantEvent(a1),
    userEvent('继续'),
    assistantEvent(a2),
    historyMessage('摘要', 'history-1'),
    assistantEvent(a3),
    ...(reflect ? [historyMessage('合并摘要', 'history-2')] : []),
  ];
  const session = makeSession({
    events,
    surfaceNodes: [0, reflect ? 7 : 5, 2, 3, 4, 6],
  });
  return { session, a1, a2, a3 };
}

/** 请求消息：与宿主一致取自 deriveMessages。 */
function requestOf(session: Session): RequestMessage[] {
  return session.deriveMessages() as RequestMessage[];
}

describe('staleAssistantIds', () => {
  it('最后一条 OM 消息之前生成的尾部 assistant 视为过期，之后生成的保留', () => {
    const { session } = compactedSession();
    expect([...staleAssistantIds(session)]).toEqual(['a1', 'a2']);
  });

  it('反思替换后尾部全部 assistant 都过期', () => {
    const { session } = compactedSession({}, true);
    expect([...staleAssistantIds(session)]).toEqual(['a1', 'a2', 'a3']);
  });

  it('反思保留尾部旧块时，旧块之后生成的 assistant 仍视为过期', () => {
    // 会话：sys(0) user(1) a1(2) user(3) a2(4) 被 H1(seq 5) 替换；反思归档 H1，AH(seq 9)
    // 追加在日志尾部但表层位于保留的尾部旧块 H2(seq 7) 之前，a3/a4 前缀被改写须判过期。
    const a3 = assistant('a3');
    const a4 = assistant('a4');
    const session = makeSession({
      events: [
        systemMessageEvent('系统提示词'),
        userEvent('任务'),
        assistantEvent(assistant('a1')),
        userEvent('继续'),
        assistantEvent(assistant('a2')),
        historyMessage('摘要1', 'history-1'),
        assistantEvent(a3),
        historyMessage('摘要2', 'history-2'),
        assistantEvent(a4),
        archivedHistoryMessage('归档', 'archived-1'),
      ],
      surfaceNodes: [0, 9, 6, 7, 8],
    });
    expect([...staleAssistantIds(session)]).toEqual(['a3', 'a4']);
  });

  it('反思提交之后生成的 assistant 不判过期', () => {
    // 与上一用例同一会话，反思提交后又生成 a5(seq 10)，其前缀含 AH，签名有效须保留。
    const a5 = assistant('a5');
    const session = makeSession({
      events: [
        systemMessageEvent('系统提示词'),
        userEvent('任务'),
        assistantEvent(assistant('a1')),
        userEvent('继续'),
        assistantEvent(assistant('a2')),
        historyMessage('摘要1', 'history-1'),
        assistantEvent(assistant('a3')),
        historyMessage('摘要2', 'history-2'),
        assistantEvent(assistant('a4')),
        archivedHistoryMessage('归档', 'archived-1'),
        assistantEvent(a5),
      ],
      surfaceNodes: [0, 9, 6, 7, 8, 10],
    });
    expect([...staleAssistantIds(session)]).toEqual(['a3', 'a4']);
  });

  it('没有 OM 消息时不判定过期', () => {
    const session = makeSession({
      events: [userEvent('任务'), assistantEvent(assistant('a1'))],
    });
    expect(staleAssistantIds(session).size).toBe(0);
  });
});

describe('isAnthropicSigned', () => {
  it('Anthropic 协议的 claude 模型带签名时为真，兼容带前缀的模型名', () => {
    expect(isAnthropicSigned(assistant('x'))).toBe(true);
    expect(
      isAnthropicSigned(
        assistant('x', { api: 'bedrock-converse-stream', model: 'us.anthropic.claude-fable-5-1' }),
      ),
    ).toBe(true);
    expect(isAnthropicSigned(assistant('x', { model: 'anthropic/claude-sonnet-5' }))).toBe(true);
    expect(isAnthropicSigned(assistant('x', { signature: '', redacted: true }))).toBe(true);
  });

  it('非 claude 模型、非 Anthropic 协议或无签名时为假', () => {
    expect(isAnthropicSigned(assistant('x', { model: 'gpt-5' }))).toBe(false);
    expect(isAnthropicSigned(assistant('x', { model: 'myclaude-1' }))).toBe(false);
    expect(isAnthropicSigned(assistant('x', { api: 'openai-responses' }))).toBe(false);
    expect(isAnthropicSigned(assistant('x', { signature: '' }))).toBe(false);
  });

  it('replayState 缺失或形态不符时为假', () => {
    const plain = makeMessage({
      role: 'assistant',
      content: [{ type: 'reasoning', text: '思考' }],
      source: { kind: 'model', provider: 'gateway', model: 'claude-opus-5' },
    }) as unknown as AssistantMessage;
    expect(isAnthropicSigned(plain)).toBe(false);
  });
});

describe('stripReasoning', () => {
  it('去掉 reasoning 与 replayState，保留 text 与 tool-call', () => {
    const stripped = stripReasoning(assistant('a1'));
    expect(stripped?.content.map((block) => block.type)).toEqual(['text', 'tool-call']);
    expect(stripped?.source).toEqual({
      kind: 'model',
      provider: 'gateway',
      model: 'claude-opus-5',
    });
    expect(stripped?.id).toBe('a1');
  });

  it('只有 reasoning 时返回 undefined', () => {
    expect(stripReasoning(assistant('a1', { withText: false }))).toBeUndefined();
  });
});

describe('sanitizeMessages', () => {
  it('只剥离过期的 Claude 消息，压缩后生成的消息原样保留', () => {
    const { session } = compactedSession();
    const request = requestOf(session);
    const result = sanitizeMessages(session, request);
    const assistants = result?.filter((message) => message.role === 'assistant') ?? [];
    expect(assistants.map((message) => message.id)).toEqual(['a1', 'a2', 'a3']);
    expect(assistants[0]?.content.some((block) => block.type === 'reasoning')).toBe(false);
    expect(assistants[1]?.content.some((block) => block.type === 'reasoning')).toBe(false);
    expect(assistants[2]).toBe(request.find((message) => message.id === 'a3'));
  });

  it('过期消息剥离后无内容时整条移除', () => {
    const { session } = compactedSession({ a2: assistant('a2', { withText: false }) });
    const result = sanitizeMessages(session, requestOf(session));
    expect(result?.map((message) => message.id)).not.toContain('a2');
    expect(result?.map((message) => message.id)).toContain('a1');
  });

  it('过期消息不是 Claude 签名时不改动', () => {
    const { session } = compactedSession({
      a1: assistant('a1', { model: 'gemini-3-pro', api: 'google-generative-ai' }),
      a2: assistant('a2', { model: 'gpt-5', api: 'openai-responses' }),
    });
    expect(sanitizeMessages(session, requestOf(session))).toBeUndefined();
  });

  it('没有 OM 消息时不改动', () => {
    const session = makeSession({
      events: [userEvent('任务'), assistantEvent(assistant('a1'))],
    });
    expect(sanitizeMessages(session, requestOf(session))).toBeUndefined();
  });
});

/** llm/stream 中间件签名（与宿主 waterfall 一致）。 */
type StreamListener = (options: GenerateOptions, next: () => unknown) => unknown;

/** 挂载插件并返回登记的 llm/stream 中间件；session 登记为活动会话。 */
function mount(session?: Session, sessionsMounted = true) {
  const ctx = makeCtx({ sessionsMounted });
  if (session !== undefined) ctx._liveSessions.set(session.id, session);
  apply(ctx, { rateLimitWaitMs: 0 });
  const listener = ctx._onCallbacks.get('llm/stream')?.[0] as StreamListener | undefined;
  return { ctx, listener };
}

/** 构造会话请求；sessionId 为 null 时省略。 */
function sessionRequest(
  session: Session,
  { sessionId = session.id, purpose }: { sessionId?: string | null; purpose?: 'compaction' } = {},
): GenerateOptions {
  return {
    provider: 'gateway',
    model: 'claude-opus-5',
    ...(sessionId === null ? {} : { sessionId }),
    ...(purpose === undefined ? {} : { purpose }),
    messages: requestOf(session),
  } as GenerateOptions;
}

/** 耗尽中间件返回的流。 */
async function drain(stream: unknown): Promise<void> {
  for await (const _ of stream as AsyncIterable<unknown>) {
    /* 只需触发下游调用 */
  }
}

describe('apply 接线（llm/stream 剥离 thinking 签名）', () => {
  it('前置注册中间件，需剥离时以新请求重新调用 llm.stream 并保留 agent loop 标记', async () => {
    const { session } = compactedSession();
    const { ctx, listener } = mount(session);
    expect(ctx._onOptions.get('llm/stream')?.[0]).toEqual({ prepend: true });
    const next = vi.fn();
    await drain(listener?.(markAgentLoopRequest(sessionRequest(session)), next));
    expect(next).not.toHaveBeenCalled();
    const sent = ctx._llmCalls[0]?.options as GenerateOptions;
    const reasoning = sent.messages.filter(
      (message) =>
        message.role === 'assistant' && message.content.some((block) => block.type === 'reasoning'),
    );
    expect(reasoning.map((message) => message.id)).toEqual(['a3']);
    expect(isAgentLoopRequest(sent)).toBe(true);
    // 重新发出的请求再次进入中间件时直接放行，不再循环
    const reentry = vi.fn(() => 'downstream');
    expect(listener?.(sent, reentry)).toBe('downstream');
    expect(reentry).toHaveBeenCalledTimes(1);
  });

  it('无需剥离、无 sessionId、辅助调用或会话不存在时直接放行', () => {
    const plain = makeSession({ events: [userEvent('任务'), assistantEvent(assistant('a1'))] });
    const { session } = compactedSession();
    const { ctx, listener } = mount(session);
    ctx._liveSessions.set('plain', plain);
    const cases: GenerateOptions[] = [
      sessionRequest(plain, { sessionId: 'plain' }),
      sessionRequest(session, { sessionId: null }),
      sessionRequest(session, { purpose: 'compaction' }),
      sessionRequest(session, { sessionId: 'missing' }),
    ];
    for (const request of cases) {
      const next = vi.fn(() => 'downstream');
      expect(listener?.(request, next)).toBe('downstream');
      expect(next).toHaveBeenCalledTimes(1);
    }
    expect(ctx._llmCalls).toHaveLength(0);
  });

  it('sessions 服务未挂载时不注册中间件', () => {
    expect(mount(undefined, false).listener).toBeUndefined();
  });
});
