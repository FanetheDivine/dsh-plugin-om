// 整条链路集成测试：真实 cordis 容器 + 真实 dsh 服务（SessionStore / SystemPrompt /
// LlmRuntime / TokenMeter / ToolRuntime）+ 自写 mock LLM adapter，驱动被测插件 apply()
// 的 agent/pre-step 压缩接线，验证 观察触发 → 摘要 → compaction 生命周期 → 表层替换
// → 压力下降 的完整链路，以及 systemPrompt 服务未挂载时的降级（om/warning + console）。

import { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { GenerateOptions, MessageId, StreamChunk } from '@deepseek-ai/dsh-llm';
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
import { apply, name } from '../src/index.ts';

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

/** 阈值以下的固定降级说明（服务端 reportDegrade 文案，断言 om/warning 载荷用）。 */
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
      compressRetryCount: 0,
      rateLimitWaitMs: 0,
      recallEnabled: false,
      semanticRecallEnabled: false,
      debug: false,
    },
  );
  const session = app.sessions.create('it-om' as SessionId) as Session;
  session.append('request/header', {
    header: { config: { provider: 'mock', model: 'mock-model' } },
    reason: 'initial',
  });
  return { app, session, adapter };
}

/** 预置 n 条大 user/message（各自独立完整消息 index 0..n-1）。 */
function seedUserMessages(session: Session, count: number, chars = 600): void {
  for (let i = 0; i < count; i += 1) {
    session.append(
      'user/message',
      {
        id: `user-${i}` as MessageId,
        role: 'user',
        content: [{ type: 'text', text: bigText(chars, `任务${i}`) }],
        source: { kind: 'user' },
      },
      { surfaceOp: 'append' },
    );
  }
}

/** 产出覆盖完整消息 index 0..last 的合法 <history> 观察块。 */
function observeHistory(last: number): string {
  const entries = Array.from(
    { length: last + 1 },
    (_, i) => `<user_message index="${i}">压缩条目${i}：任务要点与结论完整保留</user_message>`,
  );
  return `<history>\n${entries.join('\n')}\n</history>`;
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
  it('观察压缩完整链路：摘要调用 → compaction 生命周期 → 表层替换 → 压力下降', async () => {
    const { app, session, adapter } = await stackHarness({
      withSystemPrompt: true,
      chunksFor: () => [
        { type: 'text-delta', index: 0, text: observeHistory(5) } as StreamChunk,
        { type: 'finish', reason: { kind: 'stop' } } as StreamChunk,
      ],
    });
    seedUserMessages(session, 6);
    const meterBefore = app.tokenMeter.measure(session).totalTokens;
    expect(meterBefore).toBeGreaterThanOrEqual(100);

    const decision = await runPreStep(app, session);
    expect(decision).toEqual({ kind: 'enter', messages: [] }); // 未拒绝，step 放行

    // mock adapter 收到一次 compaction 摘要调用，请求形态正确
    const summaryCalls = adapter.calls.filter((c) => c.purpose === 'compaction');
    expect(summaryCalls).toHaveLength(1);
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

    // 表层收缩为单一 <history> 节点，内容为带 tip 开标签的合法观察块
    expect(session.surface.nodes).toHaveLength(1);
    expect(textOf(checkpoint)).toContain('<history tip=');
    expect(textOf(checkpoint)).toContain('<user_message index="0">');

    // 压力下降：替换后的表层启发式总量远小于压缩前
    const meterAfter = app.tokenMeter.measure(session).totalTokens;
    expect(meterAfter).toBeLessThan(meterBefore);

    // 第二次 pre-step：压缩边界后无新消息，不重复压缩
    await runPreStep(app, session);
    expect(adapter.calls.filter((c) => c.purpose === 'compaction')).toHaveLength(1);
  }, 30000);

  it('摘要调用失败耗尽：compaction/end(error) + pre-step 拒绝本 step', async () => {
    const { app, session, adapter } = await stackHarness({
      withSystemPrompt: true,
      // 适配器始终以 error 终止（真实 LlmRuntime 将其规范化为 error finish chunk）
      chunksFor: () => [{ type: 'finish', reason: { kind: 'error' } } as StreamChunk],
    });
    seedUserMessages(session, 6);

    const decision = await runPreStep(app, session);
    expect(decision).toEqual({ kind: 'reject' });
    expect(adapter.calls.filter((c) => c.purpose === 'compaction')).toHaveLength(1); // 重试 0 次
    const types = session.events.map((e) => e.type);
    expect(types).toContain('compaction/start');
    expect(types).toContain('compaction/end');
    const end = session.events.find((e) => e.type === 'compaction/end');
    const error = (end?.data as { error?: string } | undefined)?.error;
    expect(typeof error === 'string' && error !== '').toBe(true);
    // 失败不产生部分替换：表层仍为 6 条原始消息
    expect(session.surface.nodes).toHaveLength(6);
  }, 30000);

  it('systemPrompt 服务未挂载：压缩不被阻塞，om/warning 每会话一条 + console 外部输出', async () => {
    const { app, session, adapter } = await stackHarness({
      withSystemPrompt: false,
      chunksFor: () => [
        { type: 'text-delta', index: 0, text: observeHistory(5) } as StreamChunk,
        { type: 'finish', reason: { kind: 'stop' } } as StreamChunk,
      ],
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
    expect(adapter.calls.filter((c) => c.purpose === 'compaction')).toHaveLength(1);
    expect(session.events.map((e) => e.type)).toContain('compaction/end');
    // console 外部输出 + om/warning 事件（同会话去重）
    expect(consoleText).toContain(`${PLUGIN_LABEL}: ${SYSTEM_PROMPT_MISSING}`);
    const warnings = session.events.filter((e) => e.type === 'om/warning');
    expect(warnings).toHaveLength(1);
    expect((warnings[0]?.data as { problem?: string } | undefined)?.problem).toBe(
      'systemPrompt-missing',
    );

    // 第二次 pre-step：不重复 console、不重复追加 om/warning
    const consoleSpy2 = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runPreStep(app, session);
      consoleText = consoleSpy2.mock.calls.map((args) => args.join(' ')).join('\n');
    } finally {
      consoleSpy2.mockRestore();
    }
    expect(consoleText).not.toContain(`${PLUGIN_LABEL}: ${SYSTEM_PROMPT_MISSING}`);
    expect(session.events.filter((e) => e.type === 'om/warning')).toHaveLength(1);
  }, 30000);

  it('systemPrompt 服务已挂载：组装成功计价、不产生 om/warning（回归：ctx.get 容错读取不抛错）', async () => {
    const { app, session, adapter } = await stackHarness({
      withSystemPrompt: true,
      chunksFor: () => [
        { type: 'text-delta', index: 0, text: observeHistory(5) } as StreamChunk,
        { type: 'finish', reason: { kind: 'stop' } } as StreamChunk,
      ],
    });
    seedUserMessages(session, 6);

    await runPreStep(app, session);

    expect(app.get('systemPrompt')).toBeDefined();
    expect(adapter.calls.filter((c) => c.purpose === 'compaction')).toHaveLength(1);
    expect(session.events.filter((e) => e.type === 'om/warning')).toHaveLength(0);
  }, 30000);
});
