// 整条链路集成测试：真实 cordis 容器 + 真实 dsh 服务（SessionStore / SystemPrompt /
// LlmRuntime / TokenMeter / ToolRuntime）+ 自写 mock LLM adapter，驱动被测插件 apply()
// 的完整接线：
// - agent/pre-step 两级压缩（观察 → 反思），验证 触发 → 摘要 → compaction 生命周期
//   → 表层替换 → 压力下降 的完整链路，以及 systemPrompt 服务未挂载时的降级；
// - recall 工具（含语义增强）经真实 ToolRuntime 注册与 execute 管线调用。

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, type Message as LogMessage } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {
  DeveloperMessage,
  GenerateOptions,
  MessageId,
  StreamChunk,
  ToolCallId,
} from '@deepseek-ai/dsh-llm';
import { LlmAdapter, LlmRuntime } from '@deepseek-ai/dsh-llm';
import {
  KNOWN_SESSION_EVENT_TYPES,
  Session,
  SessionId,
  SessionStore,
} from '@deepseek-ai/dsh-session';
import {
  assertV4RowAdmission,
  releasedV4SessionFormatCodec,
} from '@deepseek-ai/dsh-session-format-v3-to-v4';
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { TokenMeter } from '@deepseek-ai/dsh-token-meter';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { describe, expect, it, vi } from 'vitest';

// 隔离 apply 的模型下载编排：ensureModelReady 打桩为"就绪"，避免集成测试触发真实下载
vi.mock('../src/embedding.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/embedding.ts')>();
  return {
    ...actual,
    ensureModelReady: vi.fn(async () => 'ready' as const),
  };
});

import { SUBAGENT_DESCRIPTOR_VERSION } from '@deepseek-ai/dsh-subagent';
import { PLUGIN_LABEL, PLUGIN_SOURCE_KIND } from '../src/constants.ts';
// 命中 vi.mock 打桩后的模块（ensureModelReady 为 vi.fn，可断言预热调用）
import * as embedding from '../src/embedding.ts';
import { apply, inject, name } from '../src/index.ts';
import { appendOmEvent, findOmEvents } from '../src/om-event.ts';

/** mock LLM adapter：只实现 stream()，按注入的分块工厂回放响应并记录调用。 */
class MockAdapter extends LlmAdapter {
  /** 收到的调用选项（含 purpose/system/messages），测试据此断言请求形态。 */
  readonly calls: GenerateOptions[] = [];

  constructor(
    private readonly chunksFor: (options: GenerateOptions, callIndex: number) => StreamChunk[],
  ) {
    super();
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options);
    yield* this.chunksFor(options, this.calls.length - 1);
  }
}

/** 阈值以下的固定降级说明（服务端 reportDegrade 文案，断言 om 警告信封载荷用）。 */
const SYSTEM_PROMPT_MISSING = '系统提示词服务未挂载';

/** 生成一段指定字符数的中文文本（4 字符 ≈ 1 token，配合低阈值稳定触发观察）。 */
function bigText(chars: number, seed: string): string {
  return `${seed}：${'上下文压缩集成测试样本内容。'.repeat(Math.ceil(chars / 14))}`.slice(0, chars);
}

/** 宿主/插件堆叠参数：加载真实服务与被测插件，返回容器、会话与 mock adapter。 */
async function stackHarness(options: {
  /** 是否挂载真实 SystemPrompt 服务（false 模拟旧宿主挂载失败）。 */
  withSystemPrompt: boolean;
  /** mock adapter 的分块工厂。 */
  chunksFor: (options: GenerateOptions, callIndex: number) => StreamChunk[];
  /** 可选的真实 JSONL 会话存储目录。 */
  storageRoot?: string;
  /** 覆盖默认插件配置的键（未给出的键保持默认堆叠值）。 */
  configOverrides?: Partial<{
    observeThresholdTokens: number;
    reflectThresholdTokens: number;
    tailMessageCount: number;
    recallEnabled: boolean;
    semanticRecallEnabled: boolean;
    debug: boolean;
  }>;
}) {
  const app = new Context();
  if (options.storageRoot) {
    await app.plugin(JsonlSessionPersistence, {
      root: join(options.storageRoot, 'sessions'),
      compression: 'none',
    });
  }
  await app.plugin(SessionStore);
  // TokenMeter 依赖 sessionProjections 注册表（0.1.2 起），须先挂载
  await app.plugin(SessionProjectionRegistry);
  await app.plugin(LlmRuntime);
  await app.plugin(TokenMeter);
  if (options.withSystemPrompt) {
    await app.plugin(SystemPrompt);
    await app.plugin(ToolRuntime);
  } else {
    // ToolRuntime 依赖 systemPrompt；未挂载 systemPrompt 的旧宿主以最小桩提供 tools
    app.provide('tools', { register: () => {} });
  }
  const adapter = new MockAdapter(options.chunksFor);
  app.llm.registerAdapter(['mock'], adapter);
  await app.plugin(
    { name, inject, apply },
    {
      observeThresholdTokens: 100,
      reflectThresholdTokens: 1000000,
      tailMessageCount: 0,
      rateLimitWaitMs: 0,
      recallEnabled: false,
      semanticRecallEnabled: false,
      debug: false,
      ...options.configOverrides,
    },
  );
  const session = app.sessions.create('it-om' as SessionId) as Session;
  session.append('request/header', {
    header: { config: { provider: 'mock', model: 'mock-model' } },
    reason: 'initial',
  });
  return { app, session, adapter };
}

/** 预置 n 条大 user/message（id 与文本 seed 取 from..from+n-1，各自独立完整消息 index）。 */
function seedUserMessages(session: Session, count: number, chars = 600, from = 0): void {
  for (let i = 0; i < count; i += 1) {
    const n = from + i;
    session.append(
      'user/message',
      {
        id: `user-${n}` as MessageId,
        role: 'user',
        content: [{ type: 'text', text: bigText(chars, `任务${n}`) }],
        source: { kind: 'user' },
      },
      { surfaceOp: 'append' },
    );
  }
}

/**
 * 成功完成压缩循环的 mock 分块工厂：按请求消息状态产出
 * getHistory → completeCompression（会话状态驱动，不依赖全局调用序号）。
 * 末消息为指令（纯文本 user 消息）→ getHistory；已回填工具结果（独立 tool 角色
 * 消息）→ completeCompression。场景全部由 user 消息构成时（无可压缩条目），
 * 空提交完成（未替换条目原样保留）。
 */
function toolRoundChunks() {
  return (options: GenerateOptions, _callIndex: number): StreamChunk[] => {
    const last = options.messages.at(-1);
    const hasToolResult = last?.role === 'tool';
    const nextTool = hasToolResult ? 'completeCompression' : 'getHistory';
    return [
      {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: nextTool === 'getHistory' ? ('g1' as ToolCallId) : ('c9' as ToolCallId),
          name: nextTool,
          arguments: '{}',
        },
      } as StreamChunk,
      { type: 'finish', reason: { kind: 'tool-calls' } } as StreamChunk,
    ];
  };
}

/** 宿主 v4 编码器的单行事件入型（避免引入传递依赖的类型再导出）。 */
type FormatEvent = Parameters<typeof releasedV4SessionFormatCodec.encodeEvent>[0];

/** 读取消息事件的文本内容。 */
function textOf(event: { data: unknown } | undefined): string {
  const content = (event?.data as { content?: Array<{ type?: string; text?: string }> })?.content;
  return (content ?? []).map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join('');
}

/** 触发一次 agent/pre-step（与 agent-loop 的 dispatch.waterfall 等价）。 */
async function runPreStep(app: Context, session: Session): Promise<unknown> {
  return app.waterfall(
    'agent/pre-step',
    {
      agent: { session } as unknown as Agent,
      messages: [],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    },
    async () => ({ kind: 'enter', messages: [] }),
  );
}

describe('集成：真实 cordis + dsh 服务堆叠（mock llm）整条压缩链路', () => {
  it('观察压缩完整链路：压缩循环 → compaction 生命周期 → 表层替换（user 原样保留）', async () => {
    // 场景全部为 user 消息：compressHistory 无法压缩，空提交（未替换条目原样保留）
    const { app, session, adapter } = await stackHarness({
      withSystemPrompt: true,
      chunksFor: toolRoundChunks(),
    });
    seedUserMessages(session, 3);
    // developer/message（工具集合增量变更）落入被压缩区间：不参与完整消息索引，
    // 压缩照常成功且其表层节点被 <history> 块覆盖
    session.append(
      'developer/message',
      {
        turn: 0,
        step: 0,
        message: {
          id: 'dev-1' as MessageId,
          role: 'developer',
          content: [{ type: 'text', text: bigText(200, '工具集合变更') }],
          source: { kind: 'tool-registry' },
        } as unknown as DeveloperMessage,
      },
      { surfaceOp: 'append' },
    );
    seedUserMessages(session, 3, 600, 3);
    const meterBefore = app.tokenMeter.measure(session).totalTokens;
    expect(meterBefore).toBeGreaterThanOrEqual(100);

    const decision = await runPreStep(app, session);
    // 未拒绝，step 放行；压缩遮蔽后补发进度提醒
    expect(decision).toMatchObject({ kind: 'enter' });
    expect(
      (decision as { messages: { source: { kind: string } }[] }).messages.map((m) => m.source.kind),
    ).toEqual(['plugin:dsh-plugin-om:progress']);

    // mock adapter 收到压缩循环调用（getHistory → completeCompression），请求形态正确
    const summaryCalls = adapter.calls.filter((c) => c.purpose === 'compaction');
    expect(summaryCalls.length).toBeGreaterThanOrEqual(2);
    expect(summaryCalls[0]?.provider).toBe('mock');
    expect(summaryCalls[0]?.model).toBe('mock-model');
    expect(typeof summaryCalls[0]?.system).toBe('string');

    // compaction 生命周期完整：start(observe) → summary → 替换 user/message → end（无 error）
    const types = session.snapshotEvents().map((e) => e.type);
    expect(types).toContain('compaction/start');
    expect(types).toContain('compaction/summary');
    expect(types).toContain('compaction/end');
    const start = session.snapshotEvents().find((e) => e.type === 'compaction/start');
    expect((start?.data as { phase?: string } | undefined)?.phase).toBe('observe');
    const end = session.snapshotEvents().find((e) => e.type === 'compaction/end');
    expect((end?.data as { error?: string } | undefined)?.error).toBeUndefined();

    // 替换检查点：source 为插件自有 kind，sourceEventSeqs 覆盖全部被遮蔽表层节点
    const checkpointSeq = session.surface.nodes[0];
    const checkpoint = session.snapshotEvents()[checkpointSeq as number];
    expect(checkpoint).toBeDefined();
    const source = (checkpoint?.data as { source?: { kind?: string } } | undefined)?.source;
    expect(source?.kind).toBe(PLUGIN_SOURCE_KIND);
    const shadowed =
      (checkpoint as unknown as { sourceEventSeqs?: number[] }).sourceEventSeqs ?? [];
    // sourceEventSeqs = compaction/summary seq（影子价格认领）+ 全部 7 条被遮蔽原始消息
    // （6 条 user + 1 条 developer；developer 在 user-2 与 user-3 之间，seq 4）
    expect(shadowed).toHaveLength(8);
    expect(shadowed.slice(1).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);

    // 表层收缩为单一 <history> 节点：未压缩 user 条目原样保留
    expect(session.surface.nodes).toHaveLength(1);
    expect(textOf(checkpoint)).toContain('<history tip=');
    expect(textOf(checkpoint)).toContain('<user_message index="0">');
    expect(textOf(checkpoint)).toContain('任务0');
    // developer/message 不参与完整消息索引：其内容不进入 <history> 条目
    expect(textOf(checkpoint)).not.toContain('工具集合变更');

    // 第二次 pre-step：压缩边界后无新消息，不重复压缩
    const callsBefore = adapter.calls.filter((c) => c.purpose === 'compaction').length;
    await runPreStep(app, session);
    expect(adapter.calls.filter((c) => c.purpose === 'compaction')).toHaveLength(callsBefore);
  }, 30000);

  it('压缩循环失败：compaction/end(error) + 诊断子会话落盘 + pre-step 拒绝本 step', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-om-failure-'));
    const { app, session, adapter } = await stackHarness({
      storageRoot: root,
      withSystemPrompt: true,
      // 适配器输出纯文本（无工具调用）再以 error 终止：两轮无工具调用判失败
      chunksFor: () => [
        { type: 'text-delta', index: 0, text: '模型输出的非日志内容，未通过校验' } as StreamChunk,
        { type: 'finish', reason: { kind: 'error' } } as StreamChunk,
      ],
    });
    try {
      seedUserMessages(session, 6);

      const decision = await runPreStep(app, session);
      expect(decision).toEqual({ kind: 'reject' });
      expect(adapter.calls.filter((c) => c.purpose === 'compaction')).toHaveLength(1);
      const types = session.snapshotEvents().map((e) => e.type);
      expect(types).toContain('compaction/start');
      expect(types).toContain('compaction/end');
      const end = session.snapshotEvents().find((e) => e.type === 'compaction/end');
      const error = (end?.data as { error?: string } | undefined)?.error;
      expect(typeof error === 'string' && error !== '').toBe(true);
      // 失败不产生部分替换：表层仍为 6 条原始消息
      expect(session.surface.nodes).toHaveLength(6);

      // 诊断子会话：最终失败即落盘，header 元数据指向主会话
      const children = app.sessions.list().filter((s) => s.header.origin === 'subagent');
      expect(children).toHaveLength(1);
      const child = children[0];
      expect(child?.header.parentSession).toBe(session.id);
      expect(child?.header.delegationDepth).toBe(1);
      // compaction/end error 载荷带诊断子会话 sessionId（UI 渲染行为不变）
      expect((end?.data as { diagnosticSessionId?: string } | undefined)?.diagnosticSessionId).toBe(
        child?.id,
      );
      // 首事件 descriptor：one-shot + provider om-compaction-log + label 含阶段与失败后缀
      const descriptor = child?.snapshotEvents()[0];
      expect(descriptor?.type).toBe('subagent/descriptor');
      expect(descriptor?.data).toMatchObject({
        version: SUBAGENT_DESCRIPTOR_VERSION,
        mode: 'one-shot',
        provider: 'om-compaction-log',
        label: expect.stringContaining('-失败'), // 首轮请求即 error：无完成的模型轮
      });
      // 子会话内容零加工：指令 + assistant（含模型原始输出）+ 尾部模型信息
      const assistantEvents = child
        ?.snapshotEvents()
        .filter((event) => event.type === 'assistant/message');
      expect(JSON.stringify(assistantEvents?.at(-1)?.data)).toContain(
        '压缩使用模型 mock/mock-model（默认思考等级），原始消息',
      );
      expect(JSON.stringify(assistantEvents?.at(-1)?.data)).toContain('压缩产物 无（压缩失败）');
      const promptEvent = child?.snapshotEvents().find((event) => event.type === 'user/message');
      const promptText =
        promptEvent?.type === 'user/message'
          ? promptEvent.data.content
              .map((block) => (block.type === 'text' ? block.text : ''))
              .join('')
          : '';
      expect(promptText).toContain('压缩完整消息区间'); // user 指令（压缩指令 + 区间）
      expect(promptText).not.toContain('任务0'); // 历史内容不进指令
      const rawEvent = child?.snapshotEvents().find((event) => event.type === 'assistant/message');
      const rawText =
        rawEvent?.type === 'assistant/message'
          ? rawEvent.data.message.content
              .map((block) => (block.type === 'text' ? block.text : ''))
              .join('')
          : '';
      expect(rawText).toBe('模型输出的非日志内容，未通过校验');
    } finally {
      await app.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  it('systemPrompt 服务未挂载：压缩不被阻塞，om 警告事件每会话一条 + console 外部输出', async () => {
    const { app, session, adapter } = await stackHarness({
      withSystemPrompt: false,
      chunksFor: toolRoundChunks(),
    });
    seedUserMessages(session, 6);
    expect(app.get('systemPrompt')).toBeUndefined(); // 堆叠本身未挂载 systemPrompt

    let consoleText = '';
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runPreStep(app, session);
      consoleText = consoleSpy.mock.calls.map((args) => args.join(' ')).join('\n');
    } finally {
      consoleSpy.mockRestore();
    }

    // 挂载失败不阻塞：压缩照常完成
    const callsAfter = adapter.calls.filter((c) => c.purpose === 'compaction').length;
    expect(callsAfter).toBeGreaterThanOrEqual(1);
    expect(session.snapshotEvents().map((e) => e.type)).toContain('compaction/end');
    // console 外部输出 + om 警告信封事件（同会话去重）
    expect(consoleText).toContain(`${PLUGIN_LABEL}: ${SYSTEM_PROMPT_MISSING}`);
    const warnings = findOmEvents(session, 'om/warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.data.problem).toBe('systemPrompt-missing');

    // 第二次 pre-step：不重复 console、不重复追加 om 警告事件
    const consoleSpy2 = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runPreStep(app, session);
      consoleText = consoleSpy2.mock.calls.map((args) => args.join(' ')).join('\n');
    } finally {
      consoleSpy2.mockRestore();
    }
    expect(consoleText).not.toContain(`${PLUGIN_LABEL}: ${SYSTEM_PROMPT_MISSING}`);
    expect(findOmEvents(session, 'om/warning')).toHaveLength(1);
  }, 30000);

  it('systemPrompt 服务已挂载：组装成功计价、不产生 om 警告事件（回归：ctx.get 容错读取不抛错）', async () => {
    const { app, session, adapter } = await stackHarness({
      withSystemPrompt: true,
      chunksFor: toolRoundChunks(),
    });
    seedUserMessages(session, 6);

    await runPreStep(app, session);

    expect(app.get('systemPrompt')).toBeDefined();
    expect(adapter.calls.filter((c) => c.purpose === 'compaction').length).toBeGreaterThanOrEqual(
      1,
    );
    expect(findOmEvents(session, 'om/warning')).toHaveLength(0);
  }, 30000);

  it('观察→反思两级压缩全链路：单块观察 → 反思（空提交重建）→ 新消息观察，两块并存', async () => {
    const { app, session, adapter } = await stackHarness({
      withSystemPrompt: true,
      configOverrides: { reflectThresholdTokens: 10 },
      chunksFor: toolRoundChunks(),
    });
    seedUserMessages(session, 6);
    await runPreStep(app, session); // 第一轮：仅观察压缩（反思无块跳过）

    seedUserMessages(session, 6, 600, 6);
    await runPreStep(app, session); // 第二轮：反思（块内 user 条目不可压缩 → 空提交重建）+ 观察压缩新消息

    // 三个压缩循环（每个 2 轮：getHistory → completeCompression）：观察 → 反思 → 观察
    expect(adapter.calls.filter((c) => c.purpose === 'compaction')).toHaveLength(6); // compaction/start 的 phase 序列：observe → reflect → observe
    const phases = session
      .snapshotEvents()
      .filter((e) => e.type === 'compaction/start')
      .map((e) => (e.data as { phase?: string }).phase);
    expect(phases).toEqual(['observe', 'reflect', 'observe']);
    // 全部生命周期正常收尾（无 error）
    const ends = session.snapshotEvents().filter((e) => e.type === 'compaction/end');
    expect(ends).toHaveLength(3);
    for (const end of ends) {
      expect((end.data as { error?: string }).error).toBeUndefined();
    }
    // 表层两块并存：重建块（0..5）+ 新观察块（6..11），未压缩条目原样保留
    expect(session.surface.nodes).toHaveLength(2);
    const texts = session.surface.nodes.map((seq) =>
      textOf(session.snapshotEvents()[seq as number]),
    );
    expect(texts[0]).toContain('<history tip=');
    expect(texts[0]).toContain('<user_message index="0">');
    expect(texts[0]).not.toContain('index="6"');
    expect(texts[1]).toContain('<user_message index="6">');
    expect(texts[1]).toContain('<user_message index="11">');
  }, 30000);

  it('recall 工具经真实 ToolRuntime 注册与调用：压缩后仍可回看原始内容，参数校验失败返回 isError', async () => {
    const { app, session } = await stackHarness({
      withSystemPrompt: true,
      configOverrides: { recallEnabled: true },
      chunksFor: toolRoundChunks(),
    });
    // 仅 recall 一个工具；语义增强由 semanticRecallEnabled 控制
    expect(app.tools.get('recall')).toBeDefined();
    expect(app.tools.get('recall-semantic')).toBeUndefined();

    seedUserMessages(session, 6);
    await runPreStep(app, session); // 先压缩：表层收缩为单一 <history> 块
    expect(session.surface.nodes).toHaveLength(1);

    // 经真实 execute 管线（pre-execute → body → 输出校验 → render）调用 recall
    const result = await app.tools.execute({
      callId: 'it-recall-1' as ToolCallId,
      name: 'recall',
      arguments: { start: 0, end: 5 },
      agent: { session } as unknown as Agent,
      signal: new AbortController().signal,
    });
    expect(result.isError).toBe(false);
    const value = (result as { value?: { text?: string; images?: unknown[] } }).value;
    // 被压缩的原始内容仍可按 index 区间回看
    expect(value?.text).toContain('<user_message index="0">');
    expect(value?.text).toContain('任务0');
    expect(value?.text).toContain('任务5');
    expect(value?.images).toEqual([]);
    // output.render 投影：text 块在前、内容与 value.text 一致
    const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
    expect(content?.[0]?.type).toBe('text');
    expect(content?.[0]?.text).toContain('<user_message index="0">');

    // 参数校验失败（缺 end/offset）：经真实管线物化为 isError 结果
    const bad = await app.tools.execute({
      callId: 'it-recall-2' as ToolCallId,
      name: 'recall',
      arguments: { start: 0 },
      agent: { session } as unknown as Agent,
      signal: new AbortController().signal,
    });
    expect(bad.isError).toBe(true);
    const error = (bad as { error?: { message?: string } }).error;
    expect(error?.message).toContain('end 与 offset 至少提供一个');
  }, 30000);

  it('宿主 format v4 准入：压缩产出事件与 om 私有事件为宿主已知类型，通过行准入与写编码（会话可重载/导出）', async () => {
    const { app, session } = await stackHarness({
      withSystemPrompt: true,
      chunksFor: toolRoundChunks(),
    });
    seedUserMessages(session, 6);
    await runPreStep(app, session);
    // 全部 om 私有事件类别一并验收：须落在宿主已知类型内，否则会话重载被拒
    const pendingSeq = appendOmEvent(session, 'om/observe-pending', { triggerMessageIndex: 0 });
    appendOmEvent(session, 'om/observe-invalidate', { pendingSeq });
    appendOmEvent(session, 'om/warning', { problem: 'systemPrompt-missing', message: 'm' });
    expect(findOmEvents(session)).toHaveLength(3);

    // 主会话与压缩记录子会话都含插件自产消息，逐一验收宿主持久化边界。
    // 行准入（assertV4RowAdmission）是读路径 scanner 与写路径 encodeEvent 共用的校验，
    // 即「format v4 message requires a producer-owned source kind」的来源；整卷恢复
    // 另含的 turn/step 生命周期关系属于宿主 loop 的写入职责，不在本插件验收范围
    const targets = [session, ...app.sessions.list().filter((s) => s.header.origin === 'subagent')];
    expect(targets.length).toBeGreaterThan(1);
    const rowsOf = (target: Session): FormatEvent[] =>
      // JSON 往返模拟持久化边界（品牌类型与冻结在序列化中擦除，等价于落盘后重读）
      target.snapshotEvents().map((event) => JSON.parse(JSON.stringify(event)) as FormatEvent);
    for (const target of targets) {
      for (const row of rowsOf(target)) {
        assertV4RowAdmission(row, KNOWN_SESSION_EVENT_TYPES);
        releasedV4SessionFormatCodec.encodeEvent(row);
      }
    }

    // 持久化读路径拒绝宿主未知且无 ignorable 标记的事件类型（会话重载失败），
    // live append 无法写入 ignorable，故插件写入的全部事件类型须为宿主已知类型
    const unknownTypes = targets
      .flatMap((target) => target.snapshotEvents())
      .filter((event) => !KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true)
      .map((event) => event.type);
    expect(unknownTypes).toEqual([]);

    // 负向对照：retired 'plugin' source 包装必须被拒绝，证明上述行准入对本用例有效
    const legacyRow = rowsOf(session).find((row) => row.type === 'user/message');
    if (legacyRow === undefined) throw new Error('缺 user/message 事件');
    const legacyData = legacyRow.data;
    if (legacyData === null || typeof legacyData !== 'object' || Array.isArray(legacyData))
      throw new Error('user/message 载荷非法');
    expect(() =>
      assertV4RowAdmission(
        {
          ...legacyRow,
          data: { ...legacyData, source: { kind: 'plugin', plugin: 'dsh-plugin-om' } },
        },
        KNOWN_SESSION_EVENT_TYPES,
      ),
    ).toThrow('producer-owned source kind');
  }, 30000);

  it('语义增强启用：recall 带 query 参数并后台预热模型', async () => {
    const warmup = vi.mocked(embedding.ensureModelReady);
    warmup.mockClear();
    const { app } = await stackHarness({
      withSystemPrompt: true,
      configOverrides: { recallEnabled: true, semanticRecallEnabled: true },
      chunksFor: () => [],
    });
    const parameters = app.tools.get('recall')?.parameters as { properties: object } | undefined;
    const properties = parameters?.properties ?? {};
    expect(Object.keys(properties)).toContain('query');
    expect(app.tools.get('recall-semantic')).toBeUndefined();
    // 启用即后台预热（ensureModelReady 已打桩为就绪，不触发真实下载）
    await vi.waitFor(() => {
      expect(warmup.mock.calls.length).toBeGreaterThanOrEqual(1);
    });
  }, 30000);

  it('recall 未启用时语义增强无效：不注册工具、不预热模型', async () => {
    const warmup = vi.mocked(embedding.ensureModelReady);
    warmup.mockClear();
    const { app } = await stackHarness({
      withSystemPrompt: true,
      configOverrides: { recallEnabled: false, semanticRecallEnabled: true },
      chunksFor: () => [],
    });
    expect(app.tools.get('recall')).toBeUndefined();
    expect(app.tools.get('recall-semantic')).toBeUndefined();
    expect(warmup).not.toHaveBeenCalled();
  }, 30000);
});

describe('集成：只有 llm 和 tokenMeter 的最小堆叠', () => {
  /** 只挂 llm、tokenMeter（及其前置 sessionProjections）与 mock adapter，捕获全部日志。 */
  async function minimalStack(
    configOverrides: { observeThresholdTokens?: number; debug?: boolean } = {},
  ) {
    const app = new Context();
    const logs: LogMessage[] = [];
    // default 取最大等级，捕获 error/warn/info/debug 全部输出
    app.logger.exporter({ levels: { default: 3 }, export: (message) => logs.push(message) });
    await app.plugin(SessionProjectionRegistry);
    await app.plugin(LlmRuntime);
    await app.plugin(TokenMeter);
    const adapter = new MockAdapter(toolRoundChunks());
    app.llm.registerAdapter(['mock'], adapter);
    await app.plugin(
      { name, inject, apply },
      {
        observeThresholdTokens: 100,
        reflectThresholdTokens: 1000000,
        tailMessageCount: 0,
        rateLimitWaitMs: 0,
        semanticRecallEnabled: false,
        debug: false,
        ...configOverrides,
      },
    );
    // 脱离 SessionStore 的真实会话（sessions 服务不在堆叠中）
    const session = Session.create(SessionId('it-om-minimal'));
    session.append('request/header', {
      header: { config: { provider: 'mock', model: 'mock-model' } },
      reason: 'initial',
    });
    return { app, adapter, logs, session };
  }

  it('加载不报错，缺失的 tools 和 commands 只产生 warning，recall 不注册', async () => {
    const { app, logs } = await minimalStack();
    expect(app.get('tools')).toBeUndefined();
    expect(logs.filter((m) => m.type === 'error')).toEqual([]);
    const warns = logs.filter((m) => m.type === 'warn').map((m) => String(m.args[0]));
    expect(warns.some((w) => w.includes('tools 服务未挂载'))).toBe(true);
    expect(warns.some((w) => w.includes('commands 服务未挂载'))).toBe(true);
  });

  it('pre-step 完成压缩，缺失 sessions 只产生 warning，不落盘压缩会话记录', async () => {
    const { app, adapter, logs, session } = await minimalStack();
    seedUserMessages(session, 6);
    expect(app.tokenMeter.measure(session).totalTokens).toBeGreaterThanOrEqual(100);

    const decision = await runPreStep(app, session);

    expect(decision).toMatchObject({ kind: 'enter' });
    expect(adapter.calls.filter((c) => c.purpose === 'compaction').length).toBeGreaterThanOrEqual(
      2,
    );
    const events = session.snapshotEvents();
    expect(events.some((e) => e.type === 'compaction/summary')).toBe(true);
    const end = events.find((e) => e.type === 'compaction/end');
    expect((end?.data as { error?: string } | undefined)?.error).toBeUndefined();
    expect((end?.data as { diagnosticSessionId?: string } | undefined)?.diagnosticSessionId).toBe(
      undefined,
    );
    expect(events.some((e) => e.type === 'subagent/catalog')).toBe(false);
    expect(logs.filter((m) => m.type === 'error')).toEqual([]);
    const warns = logs.filter((m) => m.type === 'warn').map((m) => String(m.args[0]));
    expect(warns.some((w) => w.includes('sessions 服务未挂载'))).toBe(true);
  });

  it('真实 tokenMeter 换算触发时序：同阈值下 2 倍用量锚点触发、无锚点跳过', async () => {
    // 探针堆叠测得确定性表层估算 S（与正式堆叠同种子、同启发式计价）
    const probe = await minimalStack();
    seedUserMessages(probe.session, 4);
    const seeded = probe.app.tokenMeter.measure(probe.session).surfaceTokens;
    // 阈值卡在启发式净压力（≈S，系数 1）与换算净压力（≈2S，系数 2）之间
    const threshold = Math.floor(seeded * 1.5);

    // 对照：无用量锚点 → 估算基线、换算系数 1，净压力低于阈值，跳过压缩
    const control = await minimalStack({ observeThresholdTokens: threshold });
    seedUserMessages(control.session, 4);
    await runPreStep(control.app, control.session);
    expect(control.adapter.calls.filter((c) => c.purpose === 'compaction')).toHaveLength(0);
    expect(control.session.snapshotEvents().some((e) => e.type === 'compaction/summary')).toBe(
      false,
    );

    // 触发：助手结算携带 2 倍表层真实用量 → 换算系数 2.00，换算净压力达阈值
    const { app, adapter, logs, session } = await minimalStack({
      observeThresholdTokens: threshold,
      debug: true,
    });
    seedUserMessages(session, 4);
    const anchorSurface = app.tokenMeter.measure(session).surfaceTokens;
    expect(anchorSurface).toBe(seeded);
    session.append('step/start', { turn: 0, step: 0 });
    session.append(
      'assistant/message',
      {
        turn: 0,
        step: 0,
        message: {
          id: 'assistant-anchor' as MessageId,
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          source: { kind: 'model', provider: 'mock', model: 'mock-model' },
        },
        stream: [],
        usage: { inputTokens: 2 * anchorSurface, outputTokens: 0 },
      },
      { surfaceOp: 'append' },
    );
    session.append('step/end', { turn: 0, step: 0 });
    const measurement = app.tokenMeter.measure(session);
    expect(measurement.baseline.kind).toBe('usage'); // 真实用量锚点生效

    await runPreStep(app, session);

    expect(adapter.calls.filter((c) => c.purpose === 'compaction').length).toBeGreaterThanOrEqual(
      2,
    );
    expect(session.snapshotEvents().some((e) => e.type === 'compaction/summary')).toBe(true);
    const steps = logs.filter((m) => m.type === 'debug').map((m) => String(m.args[0]));
    expect(steps.some((s) => s.includes('换算系数 2.00'))).toBe(true);
    expect(logs.filter((m) => m.type === 'error')).toEqual([]);
  });
});
