// Loader volatile 引用提交后的运行时接线：压缩、日志、工具目录及模型查询。
import { describe, expect, it, vi } from 'vitest';
import type { ToolDefinition, ToolRunContext } from '../src/types.ts';
import { buildToolCallFlow, makeCtx, makeSession, roundChunks } from './helpers.ts';

vi.mock('../src/embedding.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/embedding.ts')>();
  return {
    ...actual,
    ensureModelReady: vi.fn(async () => 'ready' as const),
    getEmbedder: vi.fn(
      async () => async (texts: readonly string[]) => texts.map(() => new Float32Array([1, 0])),
    ),
  };
});

import { ensureModelReady, getEmbedder } from '../src/embedding.ts';
import { apply } from '../src/index.ts';

/** 模拟 Loader 稳定 volatile 引用，配置值原地提交后才触发事件。 */
function loaderConfig(initial: Record<string, string | number | boolean>) {
  const values = { ...initial };
  const refs = Object.fromEntries(
    Object.keys(initial).map((key) => [key, { get: () => values[key] }]),
  );
  return { values, refs };
}

/** 真实工具注册表模拟：dispose 后才从列表移除。 */
function toolsHost(ctx: ReturnType<typeof makeCtx>) {
  const active = new Map<string, ToolDefinition>();
  const disposes: string[] = [];
  vi.spyOn(ctx.tools, 'register').mockImplementation((tool) => {
    if (active.has(tool.name)) throw new Error(`重复注册 ${tool.name}`);
    active.set(tool.name, tool);
    return () => {
      disposes.push(tool.name);
      active.delete(tool.name);
    };
  });
  return { active, disposes };
}

/** Loader 只向该 fiber 派发，paths 为已提交的配置键路径。 */
function update(ctx: ReturnType<typeof makeCtx>, ...paths: string[]) {
  for (const listener of ctx._onCallbacks.get('loader/volatile-update') ?? []) {
    listener(paths.map((key) => [key]));
  }
}

describe('Loader volatile 热更新', () => {
  it('不重挂载即可用新阈值和 token 上限压缩，debug 日志实时切换', async () => {
    const { values, refs } = loaderConfig({
      omEnabled: false,
      debug: false,
      tailMessageCount: 0,
      observeThresholdTokens: 1,
      compressMaxTokens: 111,
      semanticRecallEnabled: false,
    });
    const ctx = makeCtx({
      llmStreamFactory: (index) => {
        if (index % 3 === 0) return roundChunks({ calls: [{ id: 'g', name: 'getHistory' }] });
        if (index % 3 === 1)
          return roundChunks({
            calls: [
              {
                id: 'h',
                name: 'compressHistory',
                args: { start: 1, end: 2, content: 'toolcall index:2 purpose:测试 summary:完成' },
              },
            ],
          });
        return roundChunks({ calls: [{ id: 'c', name: 'completeCompression' }] });
      },
    });
    apply(ctx, refs);
    const session = makeSession({
      events: buildToolCallFlow({
        code: 'x()',
        description: '测试',
        callId: 'c1',
        resultText: 'ok',
        withTurnEnd: true,
      }),
    });
    const preStep = ctx._onCallbacks.get('agent/pre-step')?.[0];
    const run = () =>
      preStep?.({ agent: { session }, signal: new AbortController().signal }, () => {});
    await run();
    expect(ctx._llmCalls).toHaveLength(0);
    expect(ctx._loggerCalls.some((entry) => entry.level === 'debug')).toBe(false);
    values.omEnabled = true;
    values.debug = true;
    values.compressMaxTokens = 321;
    update(ctx, 'omEnabled', 'debug', 'compressMaxTokens');
    await run();
    expect(ctx._llmCalls).toHaveLength(3);
    expect((ctx._llmCalls[0]?.options as { maxTokens?: number } | undefined)?.maxTokens).toBe(321);
    expect(ctx._loggerCalls.some((entry) => entry.level === 'debug')).toBe(true);
    expect(ctx._onCallbacks.get('agent/pre-step')).toHaveLength(1);
    const logCount = ctx._loggerCalls.filter((entry) => entry.level === 'debug').length;
    values.debug = false;
    update(ctx, 'debug');
    await run();
    expect(ctx._loggerCalls.filter((entry) => entry.level === 'debug')).toHaveLength(logCount);
  });

  it('工具启停更新真实注册表且反复切换不会重复注册或遗留旧工具', () => {
    const { values, refs } = loaderConfig({ recallEnabled: true, semanticRecallEnabled: false });
    const ctx = makeCtx();
    const { active, disposes } = toolsHost(ctx);
    apply(ctx, refs);
    expect([...active.keys()]).toEqual(['recall']);
    values.recallEnabled = false;
    values.semanticRecallEnabled = true;
    update(ctx, 'recallEnabled', 'semanticRecallEnabled');
    expect([...active.keys()]).toEqual(['recall-semantic']);
    values.recallEnabled = true;
    update(ctx, 'recallEnabled');
    expect([...active.keys()].sort()).toEqual(['recall', 'recall-semantic']);
    update(ctx, 'recallEnabled');
    expect(active.size).toBe(2);
    values.recallEnabled = false;
    values.semanticRecallEnabled = false;
    update(ctx, 'recallEnabled', 'semanticRecallEnabled');
    expect([...active.keys()]).toEqual([]);
    expect(disposes).toEqual(['recall', 'recall', 'recall-semantic']);
  });

  it('目录变更预热新目录，新语义查询使用新目录嵌入模型', async () => {
    const { values, refs } = loaderConfig({ modelDir: '/old/model', semanticRecallEnabled: true });
    const ctx = makeCtx();
    const { active } = toolsHost(ctx);
    const preload = vi.mocked(ensureModelReady);
    const embed = vi.mocked(getEmbedder);
    preload.mockClear();
    embed.mockClear();
    apply(ctx, refs);
    expect(preload).toHaveBeenCalledWith(
      '/old/model',
      expect.any(Function),
      undefined,
      expect.any(Function),
    );
    values.modelDir = '/new/model';
    update(ctx, 'modelDir');
    expect(preload).toHaveBeenCalledWith(
      '/new/model',
      expect.any(Function),
      undefined,
      expect.any(Function),
    );
    const session = makeSession({
      events: buildToolCallFlow({
        code: 'search()',
        description: '被检索消息',
        callId: 'q1',
        resultText: 'ok',
        withTurnEnd: true,
      }),
    });
    const tool = active.get('recall-semantic');
    if (!tool) throw new Error('语义工具未注册');
    const result = await tool.execute({ query: '被检索消息' }, {
      agent: { session },
    } as ToolRunContext);
    expect(result).toHaveProperty('text');
    expect(embed).toHaveBeenCalledWith('/new/model');
    expect(embed).not.toHaveBeenCalledWith('/old/model');
  });

  it('在途旧查询全程固定旧模型，新查询全程使用新模型且工具表无重复', async () => {
    const { values, refs } = loaderConfig({
      modelDir: '/old/model',
      semanticRecallEnabled: true,
      recallEnabled: false,
    });
    const ctx = makeCtx();
    const { active, disposes } = toolsHost(ctx);
    const calls: Array<{ dir: string; text: string }> = [];
    let releaseOldQuery = () => {};
    const pendingOldQuery = new Promise<void>((resolve) => {
      releaseOldQuery = resolve;
    });
    vi.mocked(getEmbedder).mockImplementation(async (dir) => {
      if (!dir) throw new Error('缺少模型目录');
      return async (texts) => {
        calls.push({ dir, text: texts[0] ?? '' });
        if (dir === '/old/model' && texts[0] === '旧查询') await pendingOldQuery;
        return texts.map(() => new Float32Array([1, 0]));
      };
    });
    apply(ctx, refs);
    const oldTool = active.get('recall-semantic');
    if (!oldTool) throw new Error('旧语义工具未注册');
    const session = makeSession({
      events: buildToolCallFlow({
        code: 'search()',
        description: '测试历史',
        callId: 'q1',
        resultText: 'ok',
        withTurnEnd: true,
      }),
    });
    const exec = { agent: { session } } as ToolRunContext;
    const oldRun = oldTool.execute({ query: '旧查询' }, exec);
    await vi.waitFor(() => expect(calls).toEqual([{ dir: '/old/model', text: '旧查询' }]));
    values.modelDir = '/new/model';
    update(ctx, 'modelDir');
    const newTool = active.get('recall-semantic');
    if (!newTool) throw new Error('新语义工具未注册');
    expect(active.size).toBe(1);
    const newRun = newTool.execute({ query: '新查询' }, exec);
    await newRun;
    releaseOldQuery();
    await oldRun;
    expect(calls.filter((call) => call.dir === '/old/model')).toHaveLength(2);
    expect(calls.filter((call) => call.dir === '/new/model')).toHaveLength(2);
    expect(calls.map((call) => call.dir)).toEqual([
      '/old/model',
      '/new/model',
      '/new/model',
      '/old/model',
    ]);
    expect(disposes).toEqual(['recall-semantic']);
    expect(newTool).not.toBe(oldTool);
  });
});
