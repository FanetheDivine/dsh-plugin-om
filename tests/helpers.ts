// 单元测试公共设施：极简 Session/Surface 模拟（复刻 surface 的 append/replace 语义），
// 以及一个可编程的 ctx 模拟；另含跨测试文件共享的断言辅助
// （latestHistoryText / compactionLifecycle / checkpointSourceOf / historyMessage /
// twoCallFlow / textOf）。测试目标是 src 的纯函数与 apply 接线。
import { HISTORY_TAG, HISTORY_TIP, PLUGIN_LABEL } from '../src/constants.ts';
import type { Context, Session, SessionEvent } from '../src/types.ts';

export function makeMessage({
  role = 'user',
  content = [],
  source,
  id,
}: {
  role?: string;
  content?: unknown[];
  source?: unknown;
  id?: string;
} = {}) {
  return {
    id: id ?? `msg-${Math.random().toString(36).slice(2)}`,
    role,
    content,
    // 与真实宿主一致：未显式标记来源的用户角色消息默认 source.kind === 'user'（用户消息）；
    // 显式 source（宿主注入/插件/工具结果）原样保留（其中非 kind:user 的归为系统消息）
    ...(source ? { source } : role === 'user' ? { source: { kind: 'user' } } : {}),
  };
}

export function textBlock(text: string) {
  return { type: 'text', text };
}

/** 构造 image 内容块（attachment 为持久图片元数据，与宿主 ImageAttachmentRef 同构）。 */
export function imageBlock(
  overrides: {
    attachmentId?: string;
    mediaType?: string;
    bytes?: number;
    width?: number;
    height?: number;
    name?: string;
  } = {},
) {
  const {
    attachmentId = 'att-1',
    mediaType = 'image/png',
    bytes = 1024,
    width = 800,
    height = 600,
    name,
  } = overrides;
  return {
    type: 'image',
    attachment: {
      attachmentId,
      mediaType,
      bytes,
      width,
      height,
      ...(name === undefined ? {} : { name }),
    },
  };
}

export function toolCallBlock(id: string, name: string, args: unknown) {
  return { type: 'tool-call', id, name, arguments: args };
}

export function toolResultBlock(callId: string, content: unknown[], isError = false) {
  return { type: 'tool-result', toolCallId: callId, content, isError };
}

interface MockSessionOptions {
  events?: SessionEvent[];
  surfaceNodes?: number[];
  requestHeaderValue?: {
    config: { provider: string; model: string };
    system?: string;
    tools?: unknown[];
  };
  /** 会话创建元数据（子代理会话传 { origin: 'subagent' }）。 */
  header?: { origin?: 'subagent' };
}

/** 极简会话模拟（复刻 append/replace 表层语义，seq = 数组下标）。 */
export function makeSession({
  events = [],
  surfaceNodes,
  requestHeaderValue,
  header,
}: MockSessionOptions = {}): Session {
  // 真实宿主的每个事件都带 seq（= 日志下标）；预置事件补上，供 findLast/lastEnd.seq 等使用
  const log: SessionEvent[] = events.map(
    (event, index) => ({ ...event, seq: index }) as SessionEvent,
  );
  const nodes: number[] =
    surfaceNodes !== undefined
      ? [...surfaceNodes]
      : log
          .map((_, i) => i)
          .filter((_, i) => {
            const e = log[i];
            return (
              e &&
              (e.type === 'user/message' ||
                e.type === 'assistant/message' ||
                e.type === 'tool/result')
            );
          });
  const surface = {
    get nodes() {
      return [...nodes];
    },
    replaceGeneration: 0,
  };
  const session = {
    id: 'test-session',
    seq: 0,
    header: header ?? {},
    events: log,
    surface,
    requestHeader: () =>
      requestHeaderValue ?? { config: { provider: 'test', model: 'test-model' } },
    deriveEventMessage(event: SessionEvent | null | undefined) {
      if (!event) return null;
      if (event.type === 'user/message') return event.data;
      if (event.type === 'assistant/message') {
        if (!event.data?.message || event.data.message.content.length === 0) return null;
        return event.data.message;
      }
      if (event.type === 'tool/result') return event.data.message;
      return null;
    },
    deriveMessages() {
      return nodes
        .map((seq) => {
          const event = log[seq];
          if (!event) return null;
          if (event.type === 'user/message') return event.data;
          if (event.type === 'assistant/message') return event.data.message;
          if (event.type === 'tool/result') return event.data.message;
          return null;
        })
        .filter((message) => message !== null);
    },
    append(type: string, data: unknown, opts: Record<string, unknown> = {}) {
      const seq = log.length;
      const event: Record<string, unknown> = {
        type,
        seq,
        time: Date.now(),
        data: JSON.parse(JSON.stringify(data)),
      };
      const surfaceOp = opts.surfaceOp as
        | string
        | { op?: string; start?: number; end?: number }
        | undefined;
      if (surfaceOp === 'append') {
        event.surfaceOp = 'append';
        if (type === 'user/message' || type === 'assistant/message' || type === 'tool/result')
          nodes.push(seq);
      } else if (surfaceOp && typeof surfaceOp === 'object' && surfaceOp.op === 'replace') {
        const start = surfaceOp.start ?? -1;
        const end = surfaceOp.end ?? -1;
        const startIdx = nodes.indexOf(start);
        const endIdx = nodes.indexOf(end);
        if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
          throw new Error(`mock surface replace: invalid range ${start}-${end}`);
        }
        const shadowed = nodes.slice(startIdx, endIdx + 1);
        const sources: number[] = Array.isArray(opts.sourceEventSeqs)
          ? (opts.sourceEventSeqs as number[])
          : [];
        const missing = shadowed.filter((s) => !sources.includes(s));
        if (missing.length > 0) {
          throw new Error(`mock surface replace: sourceEventSeqs missing ${missing.join(',')}`);
        }
        event.surfaceOp = { op: 'replace', start, end };
        if (Array.isArray(opts.sourceEventSeqs))
          event.sourceEventSeqs = [...(opts.sourceEventSeqs as number[])];
        nodes.splice(startIdx, endIdx - startIdx + 1, seq);
        surface.replaceGeneration += 1;
        event.shadowedSeqs = shadowed;
      }
      log.push(event as unknown as SessionEvent);
      return event;
    },
  };
  return session as unknown as Session;
}

/** 极简 token 估算：4 字符 ≈ 1 token（与 dsh-token-meter 启发式一致）。 */
export function estimateTextTokens(text: unknown) {
  return Math.ceil(String(text ?? '').length / 4);
}

export function makeMeter(opts: { totalTokens?: number | undefined } = {}) {
  return {
    estimateMessage(message: unknown) {
      const m = message as { content?: unknown[] } | null | undefined;
      if (!m || !Array.isArray(m.content)) return 0;
      let text = '';
      for (const b of m.content) {
        const block = b as { type?: string; text?: string } | null | undefined;
        if (block && block.type === 'text' && typeof block.text === 'string') text += block.text;
      }
      return estimateTextTokens(text);
    },
    measure(session: Session) {
      let surfaceTokens = 0;
      const nodes = [];
      for (const seq of session.surface.nodes) {
        const event = session.events[seq];
        const message = event ? session.deriveEventMessage(event) : null;
        const tokens = message ? this.estimateMessage(message) : 0;
        surfaceTokens += tokens;
        nodes.push({ seq, tokens });
      }
      // totalTokens 可注入固定值模拟 provider 真实 usage 锚定；缺省回退表层启发式
      return { totalTokens: opts.totalTokens ?? surfaceTokens, surfaceTokens, nodes };
    },
  };
}

interface MockCtxOptions {
  /** 摘要流 chunk（text-delta / usage / finish；缺省单条 text-delta）。 */
  llmStream?: Iterable<unknown> | AsyncIterable<unknown>;
  /** 按调用序号返回摘要流（多块并行压缩时各块返回不同流；优先级高于 llmStream）。 */
  llmStreamFactory?: (
    callIndex: number,
    options: unknown,
  ) => Iterable<unknown> | AsyncIterable<unknown>;
  resolveModelInfo?: (provider: string, model: string) => Promise<unknown>;
  pruner?: unknown;
  /** meter.measure 返回的固定 totalTokens（模拟 provider 真实 usage；缺省回退表层启发式）。 */
  meterTotalTokens?: number;
  /** systemPrompt.assemble 桩（注入后压缩会调用它估算系统提示词 tokens 并记录到 _assembleCalls；缺省无 assemble，模拟旧宿主）。 */
  systemPromptAssemble?: (context: unknown) => Promise<unknown>;
  /**
   * systemPrompt 服务是否挂载（缺省 true）。false 时 ctx.get('systemPrompt') 返回
   * undefined，且属性访问 ctx.systemPrompt 抛错——与真实 cordis 服务未挂载行为一致，
   * 用于回归验证压缩必须经 ctx.get 容错读取。
   */
  systemPromptMounted?: boolean;
  /** meter.measure 抛错（模拟 tokenMeter 服务异常）。 */
  meterThrows?: Error;
}

/** 可编程 ctx 模拟（回调由测试注入）。 */
export function makeCtx({
  llmStream,
  llmStreamFactory,
  resolveModelInfo,
  pruner,
  meterTotalTokens,
  systemPromptAssemble,
  systemPromptMounted = true,
  meterThrows,
}: MockCtxOptions = {}) {
  const onCallbacks = new Map<string, ((...args: unknown[]) => unknown)[]>();
  const registeredTools: unknown[] = [];
  const sections: unknown[] = [];
  /** systemPrompt.assemble 调用记录（测试据此断言传入的 agent/scope/signal）。 */
  const assembleCalls: unknown[] = [];
  /** 摘要 llm.stream 调用记录（测试据此断言 options/system/messages/顺序）。 */
  const llmCalls: Array<{ options: unknown }> = [];
  /** 日志调用记录（debug/info/warn；测试据此断言步骤日志与失败日志）。 */
  const loggerCalls: Array<{ level: 'debug' | 'info' | 'warn'; args: unknown[] }> = [];
  const logger = {
    debug: (...args: unknown[]) => {
      loggerCalls.push({ level: 'debug', args });
    },
    info: (...args: unknown[]) => {
      loggerCalls.push({ level: 'info', args });
    },
    warn: (...args: unknown[]) => {
      loggerCalls.push({ level: 'warn', args });
    },
  };
  const meter = makeMeter({ totalTokens: meterTotalTokens });
  if (meterThrows !== undefined)
    meter.measure = () => {
      throw meterThrows;
    };
  const systemPromptStub = {
    section: (s: unknown) => {
      sections.push(s);
    },
    ...(systemPromptAssemble === undefined
      ? {}
      : {
          assemble: async (context: unknown) => {
            assembleCalls.push(context);
            return systemPromptAssemble(context);
          },
        }),
  };
  // systemPrompt 服务是否挂载：提供了 assemble 桩且未显式声明未挂载时视为挂载；
  // 缺省模拟未提供 systemPrompt 服务的旧宿主（get 返回 undefined、属性访问抛错）
  const systemPromptMountedNow = systemPromptMounted && systemPromptAssemble !== undefined;
  const ctx = {
    logger,
    tools: {
      register: (def: unknown) => {
        registeredTools.push(def);
      },
    },
    llm: {
      resolveModelInfo: async (provider: string, model: string) =>
        resolveModelInfo
          ? resolveModelInfo(provider, model)
          : { context: { contextWindow: 100000 } },
      stream: async function* (options: unknown) {
        llmCalls.push({ options });
        if (llmStreamFactory) yield* llmStreamFactory(llmCalls.length - 1, options);
        else if (llmStream) yield* llmStream;
        // 缺省输出为合法 <history> 块（提取校验要求：无 reasoning、index 连续、中间内容 ≥ 10 字符）
        else
          yield {
            type: 'text-delta',
            text: '<history>\n<user_message index="0">\n合并后的历史条目内容\n</user_message>\n</history>',
          };
      },
    },
    tokenMeter: meter,
    on(type: string, fn: (...args: unknown[]) => unknown) {
      let list = onCallbacks.get(type);
      if (!list) {
        list = [];
        onCallbacks.set(type, list);
      }
      list.push(fn);
      return () => true;
    },
    get(name: string) {
      if (name === 'toolResultPruner') return pruner;
      if (name === 'systemPrompt') return systemPromptMountedNow ? systemPromptStub : undefined;
      return undefined;
    },
    _onCallbacks: onCallbacks,
    _registeredTools: registeredTools,
    _sections: sections,
    _assembleCalls: assembleCalls,
    _llmCalls: llmCalls,
    _loggerCalls: loggerCalls,
  };
  // 与真实 cordis 一致：服务未挂载时属性访问抛错（回归验证压缩必须经 ctx.get 容错读取）
  Object.defineProperty(ctx, 'systemPrompt', {
    enumerable: false,
    get() {
      if (!systemPromptMountedNow) {
        throw new Error('cannot get property "systemPrompt" without inject');
      }
      return systemPromptStub;
    },
  });
  return ctx as unknown as Context & {
    _onCallbacks: Map<string, ((...args: unknown[]) => unknown)[]>;
    _registeredTools: Array<{ name?: string }>;
    _sections: Array<{ name?: string }>;
    _assembleCalls: unknown[];
    _llmCalls: Array<{ options: unknown }>;
    _loggerCalls: Array<{ level: 'debug' | 'info' | 'warn'; args: unknown[] }>;
  };
}

/** 构造一条工具调用事件流（run_code 作为示例工具）：用户消息 → 助手 toolcall → tool/call → tool/result（+可选 turn 结束）。 */
export function buildToolCallFlow({
  code,
  description,
  callId,
  resultText,
  isError = false,
  withTurnEnd = false,
  turnEndReason = { kind: 'completed' },
  userMessageId = `user-${callId}`,
  assistantMessageId = `assistant-${callId}`,
  resultMessageId = `result-${callId}`,
}: {
  code: string;
  description: string;
  callId: string;
  resultText: string;
  isError?: boolean;
  /** 是否在流末尾追加 turn/end（压缩需模拟真实日志）。 */
  withTurnEnd?: boolean;
  /** turn/end 的结束原因（默认 completed；中断测试传 aborted/interrupted）。 */
  turnEndReason?: { kind: string; reason?: { kind?: string } };
  /** 用户消息的 message_id（recall/压缩按 id 引用，测试需确定化）。 */
  userMessageId?: string;
  /** 助手消息（承载 tool-call 代码块）的 message_id。 */
  assistantMessageId?: string;
  /** tool/result 消息的 message_id。 */
  resultMessageId?: string;
}): SessionEvent[] {
  const events: SessionEvent[] = [];
  events.push({
    type: 'user/message',
    data: makeMessage({ content: [textBlock('请帮我完成一个任务')], id: userMessageId }),
  } as SessionEvent);
  events.push({
    type: 'assistant/message',
    data: {
      message: makeMessage({
        role: 'assistant',
        content: [
          textBlock('我来执行代码'),
          // 真实会话：tool-call 块 arguments 为模型产出的原始 JSON 字符串
          toolCallBlock(callId, 'run_code', JSON.stringify({ code, description })),
        ],
        source: { kind: 'model', provider: 'test', model: 'test-model' },
        id: assistantMessageId,
      }),
    },
  } as SessionEvent);
  // 真实会话：tool/call 事件 arguments 为原始 JSON 字符串（dsh-session 类型）
  events.push({
    type: 'tool/call',
    data: {
      turn: 1,
      step: 1,
      callId,
      name: 'run_code',
      arguments: JSON.stringify({ code, description }),
    },
  } as SessionEvent);
  events.push({
    type: 'tool/result',
    data: {
      turn: 1,
      step: 1,
      message: makeMessage({
        role: 'user',
        content: [toolResultBlock(callId, [textBlock(resultText)], isError)],
        source: { kind: 'tool', callId },
        id: resultMessageId,
      }),
    },
  } as SessionEvent);
  if (withTurnEnd) {
    events.push({
      type: 'turn/end',
      data: { turn: 1, reason: turnEndReason },
    } as unknown as SessionEvent);
  }
  return events;
}

/** 从会话日志提取最后一次 <history> 消息的完整文本（去标签）。 */
export function latestHistoryText(session: Session): string {
  const historyMsg = session.events.findLast(
    (e) =>
      e.type === 'user/message' &&
      String(
        ((e.data as { content?: unknown[] }).content?.[0] as { text?: string } | undefined)?.text ??
          '',
      ).includes(`<${HISTORY_TAG}`), // 兼容带 tip 属性的开标签（<history tip="…">）
  );
  const text = String(
    (
      (historyMsg as { data?: { content?: unknown[] } } | undefined)?.data?.content?.[0] as
        | { text?: string }
        | undefined
    )?.text ?? '',
  );
  return text.replace(new RegExp(`</?${HISTORY_TAG}[^>]*>`, 'g'), '').trim();
}

/** 定位一次压缩的 compaction 生命周期事件下标（start/summary/替换消息/end；缺省 -1）。 */
export function compactionLifecycle(session: Session) {
  const events = session.events;
  return {
    start: events.findIndex((e) => e.type === 'compaction/start'),
    summary: events.findIndex((e) => e.type === 'compaction/summary'),
    end: events.findIndex((e) => e.type === 'compaction/end'),
    replace: events.findIndex(
      (e) =>
        e.type === 'user/message' &&
        typeof e.surfaceOp === 'object' &&
        e.surfaceOp !== null &&
        (e.surfaceOp as { op?: string }).op === 'replace',
    ),
  };
}

/** 提取 <history> 替换消息的 source（来源标记断言用）。 */
export function checkpointSourceOf(event: SessionEvent | undefined) {
  if (event?.type !== 'user/message') return undefined;
  return event.data.source as { kind?: string; plugin?: string; compactionId?: string } | undefined;
}

/** 构造 <history> 压缩日志消息（插件自产 user/message，seq 从 0 起；与真实消息一致：无前缀句，tip 属性在开标签上）。 */
export function historyMessage(inner: string, id = 'history-msg'): SessionEvent {
  return {
    type: 'user/message',
    data: makeMessage({
      content: [textBlock(`<${HISTORY_TAG} tip="${HISTORY_TIP}">\n${inner}\n</${HISTORY_TAG}>`)],
      source: { kind: 'plugin', plugin: PLUGIN_LABEL },
      id,
    }),
  } as unknown as SessionEvent;
}

/** 构造两条 run_code 流程（消息序列纯净：0 user-c1, 1 assistant-c1, 2 result-c1, 3 user-c2, ...）。 */
export function twoCallFlow(): SessionEvent[] {
  return [
    ...buildToolCallFlow({
      code: 'firstCode()',
      description: '第一次',
      callId: 'c1',
      resultText: 'out1',
    }),
    ...buildToolCallFlow({
      code: 'secondCode()',
      description: '第二次',
      callId: 'c2',
      resultText: 'out2',
      userMessageId: 'user-c2',
      assistantMessageId: 'assistant-c2',
      resultMessageId: 'result-c2',
    }),
  ];
}

/** 取 recall / recall-semantic 输出值的文本部分（断言文本内容用；图片附件单独断言 images）。 */
export function textOf(value: unknown): string {
  return (value as { text: string }).text;
}
