// 整条链路集成测试：真实 cordis 容器 + 真实 dsh 服务（SessionStore / SystemPrompt /
// LlmRuntime / TokenMeter / ToolRuntime）+ 自写 mock LLM adapter，驱动被测插件 apply()
// 的完整接线：
// - agent/pre-step 两级压缩（观察 → 反思），验证 触发 → 摘要 → compaction 生命周期
//   → 表层替换 → 压力下降 的完整链路，以及 systemPrompt 服务未挂载时的降级；
// - recall / recall-semantic 工具经真实 ToolRuntime 注册与 execute 管线调用。

import { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { CallId, GenerateOptions, MessageId, StreamChunk } from '@deepseek-ai/dsh-llm';
import { LlmAdapter, LlmRuntime } from '@deepseek-ai/dsh-llm';
import type { Session, SessionId } from '@deepseek-ai/dsh-session';
import { SessionStore } from '@deepseek-ai/dsh-session';
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

import { PLUGIN_LABEL } from '../src/constants.ts';
// 命中 vi.mock 打桩后的模块（ensureModelReady 为 vi.fn，可断言预热调用）
import * as embedding from '../src/embedding.ts';
import { apply, name } from '../src/index.ts';
import { findOmEvents } from '../src/om-event.ts';

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
  await app.plugin(SessionStore);
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
    { name, inject: ['tools', 'llm', 'tokenMeter', 'sessions'], apply },
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
 * 末消息为指令（纯文本 user 消息）→ getHistory；已回填工具结果（含 tool-result 块的
 * user 消息）→ completeCompression。场景全部由 user 消息构成时（无可压缩条目），
 * 空提交完成（未替换条目原样保留）。
 */
function toolRoundChunks() {
  return (options: GenerateOptions, _callIndex: number): StreamChunk[] => {
    const last = options.messages.at(-1);
    const hasToolResult =
      last?.role === 'user' &&
      Array.isArray(last.content) &&
      last.content.some((b) => b.type === 'tool-result');
    const nextTool = hasToolResult ? 'completeCompression' : 'getHistory';
    return [
      {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: nextTool === 'getHistory' ? ('g1' as CallId) : ('c9' as CallId),
          name: nextTool,
          arguments: '{}',
        },
      } as StreamChunk,
      { type: 'finish', reason: { kind: 'tool-calls' } } as StreamChunk,
    ];
  };
}

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
    seedUserMessages(session, 6);
    const meterBefore = app.tokenMeter.measure(session).totalTokens;
    expect(meterBefore).toBeGreaterThanOrEqual(100);

    const decision = await runPreStep(app, session);
    expect(decision).toEqual({ kind: 'enter', messages: [] }); // 未拒绝，step 放行

    // mock adapter 收到压缩循环调用（getHistory → completeCompression），请求形态正确
    const summaryCalls = adapter.calls.filter((c) => c.purpose === 'compaction');
    expect(summaryCalls.length).toBeGreaterThanOrEqual(2);
    expect(summaryCalls[0]?.provider).toBe('mock');
    expect(summaryCalls[0]?.model).toBe('mock-model');
    expect(typeof summaryCalls[0]?.system).toBe('string');

    // compaction 生命周期完整：start(observe) → summary → 替换 user/message → end（无 error）
    const types = session.events.map((e) => e.type);
    expect(types).toContain('compaction/start');
    expect(types).toContain('compaction/summary');
    expect(types).toContain('compaction/end');
    const start = session.events.find((e) => e.type === 'compaction/start');
    expect((start?.data as { phase?: string } | undefined)?.phase).toBe('observe');
    const end = session.events.find((e) => e.type === 'compaction/end');
    expect((end?.data as { error?: string } | undefined)?.error).toBeUndefined();

    // 替换检查点：source 标记插件自产，sourceEventSeqs 覆盖全部被遮蔽表层节点
    const checkpointSeq = session.surface.nodes[0];
    const checkpoint = session.events[checkpointSeq as number];
    expect(checkpoint).toBeDefined();
    const source = (checkpoint?.data as { source?: { kind?: string; plugin?: string } } | undefined)
      ?.source;
    expect(source?.kind).toBe('plugin');
    expect(source?.plugin).toBe(PLUGIN_LABEL);
    const shadowed =
      (checkpoint as unknown as { sourceEventSeqs?: number[] }).sourceEventSeqs ?? [];
    // sourceEventSeqs = compaction/summary seq（影子价格认领）+ 全部 6 条被遮蔽原始消息
    expect(shadowed).toHaveLength(7);
    expect(shadowed.slice(1).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);

    // 表层收缩为单一 <history> 节点：未压缩 user 条目原样保留
    expect(session.surface.nodes).toHaveLength(1);
    expect(textOf(checkpoint)).toContain('<history tip=');
    expect(textOf(checkpoint)).toContain('<user_message index="0">');
    expect(textOf(checkpoint)).toContain('任务0');

    // 第二次 pre-step：压缩边界后无新消息，不重复压缩
    const callsBefore = adapter.calls.filter((c) => c.purpose === 'compaction').length;
    await runPreStep(app, session);
    expect(adapter.calls.filter((c) => c.purpose === 'compaction')).toHaveLength(callsBefore);
  }, 30000);

  it('压缩循环失败：compaction/end(error) + 诊断子会话落盘 + pre-step 拒绝本 step', async () => {
    const { app, session, adapter } = await stackHarness({
      withSystemPrompt: true,
      // 适配器输出纯文本（无工具调用）再以 error 终止：两轮无工具调用判失败
      chunksFor: () => [
        { type: 'text-delta', index: 0, text: '模型输出的非日志内容，未通过校验' } as StreamChunk,
        { type: 'finish', reason: { kind: 'error' } } as StreamChunk,
      ],
    });
    seedUserMessages(session, 6);

    const decision = await runPreStep(app, session);
    expect(decision).toEqual({ kind: 'reject' });
    expect(adapter.calls.filter((c) => c.purpose === 'compaction')).toHaveLength(1);
    const types = session.events.map((e) => e.type);
    expect(types).toContain('compaction/start');
    expect(types).toContain('compaction/end');
    const end = session.events.find((e) => e.type === 'compaction/end');
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
    // 首事件 descriptor：one-shot + provider om-compaction-log + label 含阶段与轮数
    const descriptor = child?.events[0];
    expect(descriptor?.type).toBe('subagent/descriptor');
    expect(descriptor?.data).toMatchObject({
      version: 2,
      mode: 'one-shot',
      provider: 'om-compaction-log',
      label: 'OM 压缩失败日志（观察 · 0 轮）', // 首轮请求即 error：无完成的模型轮
    });
    // 子会话内容零加工：指令 + assistant（含模型原始输出）
    const promptText = (
      (child?.events[1]?.data as { content?: Array<{ text?: string }> } | undefined)?.content ?? []
    )
      .map((b) => b.text ?? '')
      .join('');
    expect(promptText).toContain('压缩完整消息区间'); // user 指令（压缩指令 + 区间）
    expect(promptText).not.toContain('任务0'); // 历史内容不进指令
    const rawText = (
      (child?.events[2]?.data as { message?: { content?: Array<{ text?: string }> } } | undefined)
        ?.message?.content ?? []
    )
      .map((b) => b.text ?? '')
      .join('');
    expect(rawText).toBe('模型输出的非日志内容，未通过校验');
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
    expect(session.events.map((e) => e.type)).toContain('compaction/end');
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
    const phases = session.events
      .filter((e) => e.type === 'compaction/start')
      .map((e) => (e.data as { phase?: string }).phase);
    expect(phases).toEqual(['observe', 'reflect', 'observe']);
    // 全部生命周期正常收尾（无 error）
    const ends = session.events.filter((e) => e.type === 'compaction/end');
    expect(ends).toHaveLength(3);
    for (const end of ends) {
      expect((end.data as { error?: string }).error).toBeUndefined();
    }
    // 表层两块并存：重建块（0..5）+ 新观察块（6..11），未压缩条目原样保留
    expect(session.surface.nodes).toHaveLength(2);
    const texts = session.surface.nodes.map((seq) => textOf(session.events[seq as number]));
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
    // recallEnabled 注册、semanticRecallEnabled 未启用不注册
    expect(app.tools.get('recall')).toBeDefined();
    expect(app.tools.get('recall-semantic')).toBeUndefined();

    seedUserMessages(session, 6);
    await runPreStep(app, session); // 先压缩：表层收缩为单一 <history> 块
    expect(session.surface.nodes).toHaveLength(1);

    // 经真实 execute 管线（pre-execute → body → 输出校验 → render）调用 recall
    const result = await app.tools.execute({
      callId: 'it-recall-1' as CallId,
      name: 'recall',
      arguments: { start: 0, end: 5 },
      agent: { session } as unknown as Agent,
      signal: new AbortController().signal,
    });
    expect(result.isError).toBe(false);
    const value = (result as { value?: { text?: string; images?: unknown[] } }).value;
    // 被压缩的原始内容仍可按 index 区间回看
    expect(value?.text).toContain('-- [index 0] user --');
    expect(value?.text).toContain('任务0');
    expect(value?.text).toContain('任务5');
    expect(value?.images).toEqual([]);
    // output.render 投影：text 块在前、内容与 value.text 一致
    const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
    expect(content?.[0]?.type).toBe('text');
    expect(content?.[0]?.text).toContain('[index 0]');

    // 参数校验失败（缺 end/offset）：经真实管线物化为 isError 结果
    const bad = await app.tools.execute({
      callId: 'it-recall-2' as CallId,
      name: 'recall',
      arguments: { start: 0 },
      agent: { session } as unknown as Agent,
      signal: new AbortController().signal,
    });
    expect(bad.isError).toBe(true);
    const error = (bad as { error?: { message?: string } }).error;
    expect(error?.message).toContain('end 与 offset 至少提供一个');
  }, 30000);

  it('recall-semantic 启用：注册工具并后台预热模型（recall 未启用时不注册 recall）', async () => {
    const warmup = vi.mocked(embedding.ensureModelReady);
    warmup.mockClear();
    const { app } = await stackHarness({
      withSystemPrompt: true,
      configOverrides: { recallEnabled: false, semanticRecallEnabled: true },
      chunksFor: () => [],
    });
    expect(app.tools.get('recall')).toBeUndefined();
    expect(app.tools.get('recall-semantic')).toBeDefined();
    // 启用即后台预热（ensureModelReady 已打桩为就绪，不触发真实下载）
    await vi.waitFor(() => {
      expect(warmup.mock.calls.length).toBeGreaterThanOrEqual(1);
    });
  }, 30000);
});
