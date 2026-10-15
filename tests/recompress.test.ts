// recompress.ts 单元测试：重压缩命令行解析 parseRecompressInput、按 compactionId 定位
// 已成功压缩（compaction/summary + 无错误的 compaction/end）、观察/反思视图重放、
// 以指定模型与思考等级运行压缩循环、会话记录标题标记、原会话日志不被改动、
// 同会话并行、signal 中止、非主会话/未知 id/缺 shadowedSeqs/失败压缩的错误返回。

import { beforeEach, describe, expect, it } from 'vitest';

import { clearCompressionModelInfoCache, observePass, reflectPass } from '../src/compress.ts';
import { resolveConfig } from '../src/config.ts';
import { apply } from '../src/index.ts';
import { parseRecompressInput, recompress } from '../src/recompress.ts';
import type { Context, Session } from '../src/types.ts';
import {
  historyMessage,
  makeCtx,
  makeSession,
  type RoundScript,
  roundChunks,
  twoCallFlow,
} from './helpers.ts';

const ORIGINAL = { provider: 'test', model: 'test-model' };
const ALT = { provider: 'alt', model: 'vendor/big-1' };

/** 一轮 getHistory → 提交所有条目 → completeCompression 的脚本化流。 */
function scriptedFactory(summaryByIndex: Record<number, string>): (index: number) => unknown[] {
  return (index) => {
    const scripts: RoundScript[] = [
      { calls: [{ id: 'g', name: 'getHistory' }] },
      {
        calls: Object.entries(summaryByIndex).map(([entryIndex, content]) => ({
          id: `c${entryIndex}`,
          name: 'compressHistory',
          args: { index: Number(entryIndex), content },
        })),
      },
      { calls: [{ id: 'done', name: 'completeCompression' }] },
    ];
    return roundChunks(scripts[Math.min(index, scripts.length - 1)] as RoundScript);
  };
}

/** 对 twoCallFlow 会话跑一次真实观察压缩，返回会话与其 compactionId。 */
async function observedSession(): Promise<{ session: Session; compactionId: string }> {
  const session = makeSession({ events: twoCallFlow() });
  const ctx = makeCtx({
    meterTotalTokens: 1_000_000,
    llmStreamFactory: (index) => scriptedFactory({ 1: '原模型的助手摘要' })(index),
  });
  const result = await observePass(
    ctx,
    { session } as never,
    resolveConfig({ observeThresholdTokens: 1, tailMessageCount: 0, rateLimitWaitMs: 0 }),
    0,
    ORIGINAL,
  );
  expect(result.failed).toBe(false);
  return { session, compactionId: lastCompactionId(session) };
}

/** 取最后一个 compaction/summary 的 compactionId。 */
function lastCompactionId(session: Session): string {
  const summary = session.snapshotEvents().findLast((e) => e.type === 'compaction/summary');
  if (summary === undefined) throw new Error('会话无 compaction/summary');
  return String((summary.data as { compactionId: string }).compactionId);
}

/** 对 recompress 的调用封装。 */
function run(
  ctx: Context,
  session: Session,
  compactionId: string,
  extra: { reasoningEffort?: string; signal?: AbortSignal } = {},
) {
  return recompress(
    ctx,
    { session } as never,
    resolveConfig({ rateLimitWaitMs: 0 }),
    {
      compactionId,
      ...ALT,
      ...(extra.reasoningEffort ? { reasoningEffort: extra.reasoningEffort } : {}),
    },
    extra.signal,
  );
}

beforeEach(() => {
  clearCompressionModelInfoCache();
});

describe('parseRecompressInput：命令行解析', () => {
  it('compactionId provider model [effort]，effort 可省略，model 可含斜杠', () => {
    expect(parseRecompressInput(' c-1 alt vendor/big-1 ')).toEqual({
      ok: true,
      request: { compactionId: 'c-1', provider: 'alt', model: 'vendor/big-1' },
    });
    expect(parseRecompressInput('c-1 alt big-1 high')).toEqual({
      ok: true,
      request: { compactionId: 'c-1', provider: 'alt', model: 'big-1', reasoningEffort: 'high' },
    });
  });

  it('参数不足或多余返回带用法的错误', () => {
    for (const raw of ['', 'c-1', 'c-1 alt', 'c-1 alt m high extra']) {
      const parsed = parseRecompressInput(raw);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain('om-recompress');
    }
  });
});

describe('recompress：观察压缩重放', () => {
  it('以指定模型重压缩：请求携带目标 provider/model/effort，成功文本含模型与新旧摘要对比', async () => {
    const { session, compactionId } = await observedSession();
    const before = session.snapshotEvents().length;
    const surfaceBefore = [...session.surface.nodes];
    const ctx = makeCtx({
      llmStreamFactory: (index) => scriptedFactory({ 1: '另一个模型的摘要' })(index),
    });
    const result = await run(ctx, session, compactionId, { reasoningEffort: 'high' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain('另一个模型的摘要');
    // 原始字符数与 OM 卡片（compaction/summary.shadowedCharCount）同一口径
    const summaryData = session.snapshotEvents().find((e) => e.type === 'compaction/summary')
      ?.data as { shadowedCharCount?: number } | undefined;
    expect(summaryData?.shadowedCharCount).toBeGreaterThan(0);
    expect(result.originalChars).toBe(summaryData?.shadowedCharCount);
    expect(result.recordSessionId).toBe(ctx._createdSessions[0]?.id);
    expect(ctx._llmCalls[0]?.options).toMatchObject({
      provider: ALT.provider,
      model: ALT.model,
      reasoningEffort: 'high',
    });
    // 视图与原压缩一致：getHistory 返回的条目来自原遮蔽区间
    const firstRound = ctx._createdSessions[0]?.session.snapshotEvents() ?? [];
    expect(JSON.stringify(firstRound)).toContain('请帮我完成一个任务');
    // 子会话 label 带重压缩标记，父会话仅多一条 subagent/catalog
    const descriptor = firstRound.find((e) => e.type === 'subagent/descriptor');
    expect(descriptor?.data).toMatchObject({
      label: expect.stringContaining('重压缩 alt/vendor/big-1'),
    });
    const appended = session.snapshotEvents().slice(before);
    expect(appended.map((e) => e.type)).toEqual(['subagent/catalog']);
    expect([...session.surface.nodes]).toEqual(surfaceBefore);
  });

  it('重压缩失败：返回错误与诊断子会话 id，日志标题为失败日志', async () => {
    const { session, compactionId } = await observedSession();
    const ctx = makeCtx({ llmStreamFactory: () => roundChunks({ text: '纯文本不调工具' }) });
    const result = await run(ctx, session, compactionId);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('未调用压缩工具');
    expect(result.recordSessionId).toBe(ctx._createdSessions[0]?.id);
    const descriptor = ctx._createdSessions[0]?.session
      .snapshotEvents()
      .find((e) => e.type === 'subagent/descriptor');
    expect(descriptor?.data).toMatchObject({
      label: expect.stringMatching(/失败日志.*重压缩 alt\/vendor\/big-1/),
    });
  });
});

describe('recompress：反思压缩重放', () => {
  it('反思后仍可重放：从被遮蔽的 <history> 块重建视图', async () => {
    const session = makeSession({
      events: [
        historyMessage('<user_message index="0"><![CDATA[旧内容A]]></user_message>', 'h1'),
        historyMessage('<assistant index="1"><![CDATA[旧内容B]]></assistant>', 'h2'),
      ],
    });
    const reflectCtx = makeCtx({
      llmStreamFactory: (index) => scriptedFactory({ 0: '合并A', 1: '合并B' })(index),
    });
    const reflected = await reflectPass(
      reflectCtx,
      { session } as never,
      resolveConfig({ reflectThresholdTokens: 1, rateLimitWaitMs: 0 }),
      ORIGINAL,
    );
    expect(reflected.failed).toBe(false);
    const compactionId = lastCompactionId(session);
    const ctx = makeCtx({
      llmStreamFactory: (index) => scriptedFactory({ 0: '新合并A', 1: '新合并B' })(index),
    });
    const result = await run(ctx, session, compactionId);
    expect(result.ok).toBe(true);
    const created = JSON.stringify(ctx._createdSessions[0]?.session.snapshotEvents());
    expect(created).toContain('旧内容A');
    expect(created).toContain('旧内容B');
    expect(created).not.toContain('合并A"');
  });
});

describe('recompress：拒绝与互斥', () => {
  it('未知 compactionId、失败压缩、缺 shadowedSeqs 的旧载荷均返回明确错误且不请求模型', async () => {
    const { session, compactionId } = await observedSession();
    const ctx = makeCtx();
    const unknown = await run(ctx, session, 'nope');
    expect(unknown).toMatchObject({ ok: false });
    if (!unknown.ok) expect(unknown.error).toContain('nope');

    const failedSession = makeSession({ events: twoCallFlow() });
    failedSession.append('compaction/start', {
      compactionId: 'bad',
      turn: null,
      phase: 'observe',
    } as never);
    failedSession.append('compaction/end', {
      compactionId: 'bad',
      turn: null,
      error: '失败了',
    } as never);
    const failed = await run(ctx, failedSession, 'bad');
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error).toContain('未成功');

    const legacy = makeSession({ events: twoCallFlow() });
    legacy.append('compaction/start', {
      compactionId: 'old',
      turn: null,
      phase: 'observe',
    } as never);
    legacy.append('compaction/summary', {
      compactionId: 'old',
      summary: [{ type: 'text', text: 's' }],
      shadowedRange: { start: 0, end: 3 },
      shadowedTokenCount: 1,
      provider: 'p',
      model: 'm',
    } as never);
    legacy.append('compaction/end', { compactionId: 'old', turn: null } as never);
    const old = await run(ctx, legacy, 'old');
    expect(old.ok).toBe(false);
    if (!old.ok) expect(old.error).toContain('shadowedSeqs');
    expect(ctx._llmCalls).toHaveLength(0);
    expect(compactionId).not.toBe('');
  });

  it('子代理会话拒绝重压缩', async () => {
    const { session } = await observedSession();
    const sub = makeSession({ events: [], header: { origin: 'subagent' } });
    const ctx = makeCtx();
    const result = await run(ctx, sub, lastCompactionId(session));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('主会话');
  });

  it('同一会话可并行重压缩，各自独立完成并各写一份会话记录', async () => {
    const { session, compactionId } = await observedSession();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ctx = makeCtx({
      llmStreamFactory: (index) =>
        (async function* () {
          await gate;
          yield* scriptedFactory({ 1: 'y' })(index);
        })(),
    });
    const first = run(ctx, session, compactionId);
    const second = run(ctx, session, compactionId);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.recordSessionId).not.toBe(b.recordSessionId);
  });

  it('signal 已中止：返回中止错误，不落盘失败日志', async () => {
    const { session, compactionId } = await observedSession();
    const controller = new AbortController();
    controller.abort();
    const ctx = makeCtx();
    const result = await run(ctx, session, compactionId, { signal: controller.signal });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.recordSessionId).toBeUndefined();
    expect(ctx._createdSessions).toHaveLength(0);
  });
});

describe('/om-recompress 命令：apply 接线', () => {
  const quietConfig = { recallEnabled: false, rateLimitWaitMs: 0 };

  it('commands 服务可用时注册命令，缺失时插件照常加载且不注册', () => {
    const mounted = makeCtx({ commandsMounted: true });
    apply(mounted, quietConfig);
    expect(mounted._registeredCommands.map((c) => c.name)).toEqual(['om-recompress']);

    const missing = makeCtx();
    expect(() => apply(missing, quietConfig)).not.toThrow();
    expect(missing._registeredCommands).toEqual([]);
  });

  it('处理函数：成功返回对比文本，参数错误与压缩失败返回 error', async () => {
    const { session, compactionId } = await observedSession();
    const ctx = makeCtx({
      commandsMounted: true,
      llmStreamFactory: (index) => scriptedFactory({ 1: '另一个模型的摘要' })(index),
    });
    apply(ctx, quietConfig);
    const command = ctx._registeredCommands[0];
    const call = (rawInput: string) =>
      command?.handler({
        agent: { session },
        rawInput,
        signal: new AbortController().signal,
      });

    const ok = await call(` ${compactionId} alt vendor/big-1 high`);
    expect(ok?.kind).toBe('success');
    // 形如「重压缩完成 字符 原始消息 → 产物，耗时，模型(等级)」，不再附子会话 id
    expect(ok?.text).toMatch(
      /^重压缩完成 字符 [\d.]+[kwM]? → [\d.]+[kwM]?，\d+\.\ds，alt\/vendor\/big-1\(high\)$/,
    );
    expect(ctx._llmCalls[0]?.options).toMatchObject({ provider: 'alt', reasoningEffort: 'high' });

    const defaultEffort = await call(` ${compactionId} alt big-2`);
    expect(defaultEffort?.text).toMatch(/，alt\/big-2\(默认\)$/);

    const bad = await call('only-one-arg');
    expect(bad).toMatchObject({ kind: 'error' });
    expect(bad?.text).toContain('用法');

    const missing = await call('nope alt big-1');
    expect(missing).toMatchObject({ kind: 'error' });
    expect(missing?.text).toContain('nope');
  });
});
