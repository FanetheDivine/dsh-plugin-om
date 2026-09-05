// degrade.ts 经 apply 接线的降级测试：挂载失败时发 om/warning 事件并经 console 输出警告，
// 且不阻塞压缩流程（观察照常触发）。
import { describe, expect, it, vi } from 'vitest';

// 隔离 apply 的模型下载编排：ensureModelReady 打桩为"就绪"，避免单测触发真实下载/网络
vi.mock('../src/embedding.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/embedding.ts')>();
  return {
    ...actual,
    ensureModelReady: vi.fn(async () => 'ready' as const),
  };
});

import { apply } from '../src/index.ts';
import type { Session } from '../src/types.ts';
import { buildToolCallFlow, makeCtx, makeSession, roundChunks } from './helpers.ts';

describe('挂载失败降级（om/warning 事件 + console 外部输出，不阻塞压缩）', () => {
  /** 运行 pre-step 监听器。 */
  async function runPreStep(ctx: ReturnType<typeof makeCtx>, session: Session) {
    const listeners = ctx._onCallbacks.get('agent/pre-step');
    await listeners?.[0]?.({ agent: { session }, signal: new AbortController().signal }, () => {});
  }

  /** 成功完成压缩的工具轮工厂（观察照常触发的判定 mock）。 */
  function successFactory() {
    return (index: number) => {
      if (index === 0) return roundChunks({ calls: [{ id: 'g1', name: 'getHistory' }] });
      if (index === 1)
        return roundChunks({
          calls: [
            {
              id: 't2',
              name: 'compressHistory',
              args: { start: 1, end: 2, content: '完成' },
            },
          ],
        });
      return roundChunks({ calls: [{ id: 'c9', name: 'completeCompression' }] });
    };
  }

  /** 读取 om/warning 事件（session.events 中的 log-only 警告）。 */
  function warningsOf(session: Session): Array<{ problem: string; message: string }> {
    return session.events
      .filter((e) => e.type === 'om/warning')
      .map((e) => e.data as { problem: string; message: string });
  }

  it('systemPrompt 服务未挂载：压缩不抛错、console.warn 外部输出、om/warning 追加一次、按 0 计继续观察', async () => {
    const session = makeSession({
      events: buildToolCallFlow({
        code: 'a()',
        description: '任务A',
        callId: 'c1',
        resultText: 'r1',
        withTurnEnd: true,
      }),
    });
    const ctx = makeCtx({
      systemPromptMounted: false,
      meterTotalTokens: 50,
      llmStreamFactory: successFactory(),
    });
    apply(ctx, { observeThresholdTokens: 10, tailMessageCount: 0 });
    let consoleText = '';
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runPreStep(ctx, session);
      consoleText = consoleSpy.mock.calls.map((args) => args.join(' ')).join('\n');
    } finally {
      consoleSpy.mockRestore();
    }
    // 未挂载时按 0 计：净压力 50 ≥ 阈值 10 → 观察照常触发（压缩不被阻塞）
    expect(ctx._llmCalls).toHaveLength(3);
    expect(ctx._assembleCalls).toHaveLength(0);
    // console 外部输出一次 + om/warning 事件一条（同会话去重）
    expect(consoleText).toContain('dsh-plugin-om: 系统提示词服务未挂载');
    const warns = warningsOf(session);
    expect(warns).toHaveLength(1);
    expect(warns[0]?.problem).toBe('systemPrompt-missing');
    expect(warns[0]?.message).toContain('系统提示词服务未挂载');
  });

  it('systemPrompt 服务未挂载：同会话第二次 pre-step 不重复 console / 不重复追加 om/warning', async () => {
    const session = makeSession({
      events: buildToolCallFlow({
        code: 'a()',
        description: '任务A',
        callId: 'c1',
        resultText: 'r1',
        withTurnEnd: true,
      }),
    });
    const ctx = makeCtx({ systemPromptMounted: false, meterTotalTokens: 1 });
    apply(ctx, { observeThresholdTokens: 100000 });
    let consoleText = '';
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runPreStep(ctx, session);
      await runPreStep(ctx, session);
      consoleText = consoleSpy.mock.calls.map((args) => args.join(' ')).join('\n');
    } finally {
      consoleSpy.mockRestore();
    }
    expect(warningsOf(session)).toHaveLength(1);
    const degraded = consoleText.split('\n').filter((s) => s.includes('dsh-plugin-om'));
    expect(degraded).toHaveLength(1);
    // 插件日志同样只在首次出现时输出一次
    const warns = ctx._loggerCalls.filter((c) => c.level === 'warn').map((c) => String(c.args[0]));
    expect(warns.filter((s) => s.includes('系统提示词服务未挂载'))).toHaveLength(1);
  });

  it('systemPrompt.assemble 失败：仅记日志（无 om/warning、不 console），按 0 计不阻塞压缩', async () => {
    const session = makeSession({
      events: buildToolCallFlow({
        code: 'a()',
        description: '任务A',
        callId: 'c1',
        resultText: 'r1',
        withTurnEnd: true,
      }),
    });
    const ctx = makeCtx({
      meterTotalTokens: 50,
      systemPromptAssemble: async () => {
        throw new Error('boom');
      },
    });
    apply(ctx, { observeThresholdTokens: 100000, tailMessageCount: 0 });
    let consoleText = '';
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runPreStep(ctx, session);
      consoleText = consoleSpy.mock.calls.map((args) => args.join(' ')).join('\n');
    } finally {
      consoleSpy.mockRestore();
    }
    expect(ctx._llmCalls).toHaveLength(0); // 组装失败按 0 计，流程继续走到阈值判定并正常跳过
    const warns = ctx._loggerCalls.filter((c) => c.level === 'warn').map((c) => String(c.args[0]));
    expect(warns.some((s) => s.includes('系统提示词 tokens 估算失败，按 0 计: boom'))).toBe(true);
    const steps = ctx._loggerCalls.filter((c) => c.level === 'debug').map((c) => String(c.args[0]));
    expect(steps.some((s) => s.includes('− 系统提示词 0 − 工具定义 0）< 阈值 100000'))).toBe(true);
    expect(warningsOf(session)).toHaveLength(0);
    expect(consoleText).not.toContain('dsh-plugin-om');
  });

  it('requestHeader 读取失败：工具定义按 0 计、仅记日志（无 om/warning），观察不被阻塞', async () => {
    const session = makeSession({
      events: buildToolCallFlow({
        code: 'a()',
        description: '任务A',
        callId: 'c1',
        resultText: 'r1',
        withTurnEnd: true,
      }),
    });
    // 首次调用（routedTarget 路由）正常，其后调用（工具定义估算）抛错
    let headerCalls = 0;
    session.requestHeader = () => {
      headerCalls += 1;
      if (headerCalls > 1) throw new Error('header gone');
      return { config: { provider: 'test', model: 'test-model' } };
    };
    const ctx = makeCtx({
      meterTotalTokens: 50,
      systemPromptAssemble: async () => ({
        sections: [],
        contexts: [],
        tools: [],
        variables: {},
      }),
      llmStreamFactory: successFactory(),
    });
    apply(ctx, { observeThresholdTokens: 10, tailMessageCount: 0 });
    await runPreStep(ctx, session);
    expect(ctx._llmCalls).toHaveLength(3);
    const warns = ctx._loggerCalls.filter((c) => c.level === 'warn').map((c) => String(c.args[0]));
    expect(warns.some((s) => s.includes('工具定义 tokens 估算失败，按 0 计: header gone'))).toBe(
      true,
    );
    expect(warningsOf(session)).toHaveLength(0);
  });

  it('tokenMeter.measure 抛错：本轮跳过观察压缩（无摘要调用）、om/warning 追加一次、turn 不中断', async () => {
    const session = makeSession({
      events: buildToolCallFlow({
        code: 'a()',
        description: '任务A',
        callId: 'c1',
        resultText: 'r1',
        withTurnEnd: true,
      }),
    });
    const ctx = makeCtx({
      meterTotalTokens: 500000,
      meterThrows: new Error('meter offline'),
      llmStreamFactory: successFactory(),
    });
    apply(ctx, { observeThresholdTokens: 100000, tailMessageCount: 0 });
    let consoleText = '';
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runPreStep(ctx, session);
      consoleText = consoleSpy.mock.calls.map((args) => args.join(' ')).join('\n');
    } finally {
      consoleSpy.mockRestore();
    }
    expect(ctx._llmCalls).toHaveLength(0); // 无压力数据 → 跳过观察
    expect(warningsOf(session)).toHaveLength(1);
    expect(warningsOf(session)[0]?.problem).toBe('tokenMeter-unavailable');
    expect(consoleText).toContain('dsh-plugin-om: token 计量服务异常');
  });

  it('tokenMeter.estimateMessage 抛错：该消息按 0 计，压缩提交照常完成、om/warning 追加一次', async () => {
    const session = makeSession({
      events: buildToolCallFlow({
        code: 'a()',
        description: '任务A',
        callId: 'c1',
        resultText: 'r1',
        withTurnEnd: true,
      }),
    });
    const ctx = makeCtx({
      systemPromptAssemble: async () => ({
        sections: [],
        contexts: [],
        tools: [],
        variables: {},
      }),
      llmStreamFactory: successFactory(),
    });
    // measure 正常（压力注入 500000），仅 commit 阶段的 estimateMessage 抛错
    const meter = ctx.tokenMeter as unknown as {
      measure: (s: Session) => { totalTokens: number };
      estimateMessage: (m: unknown) => number;
    };
    meter.measure = () => ({ totalTokens: 500000 });
    meter.estimateMessage = () => {
      throw new Error('estimate offline');
    };
    apply(ctx, { observeThresholdTokens: 100000, tailMessageCount: 0 });
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runPreStep(ctx, session);
    } finally {
      consoleSpy.mockRestore();
    }
    // 压缩循环与替换照常完成（estimateMessage 失败按 0 计）
    expect(ctx._llmCalls).toHaveLength(3);
    const types = session.events.map((e) => e.type);
    expect(types).toContain('compaction/summary');
    expect(types).toContain('compaction/end');
    expect(warningsOf(session)).toHaveLength(1);
    expect(warningsOf(session)[0]?.problem).toBe('tokenMeter-unavailable');
    // shadowedTokenCount 按 0 计写入 compaction/summary 载荷
    const summary = session.events.find((e) => e.type === 'compaction/summary');
    const summaryData = summary?.data as { shadowedTokenCount?: number } | undefined;
    expect(summaryData?.shadowedTokenCount).toBe(0);
  });
});
