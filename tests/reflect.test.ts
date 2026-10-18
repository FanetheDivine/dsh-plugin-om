/**
 * 异步反思：归档块选择、后台任务不阻塞、单任务、提交校验、skill 注入与失败重试条件。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  commitReflection,
  estimateTextTokens,
  historySection,
  reflectPass,
} from '../src/compress.ts';
import { resolveConfig } from '../src/config.ts';
import { SKILL_INVOCATION_KIND } from '../src/constants.ts';
import { disposeAllReflections, peekReflectJob, selectArchiveBlocks } from '../src/reflect.ts';
import type { Session } from '../src/types.ts';
import {
  historyMessage,
  makeCtx,
  makeMessage,
  makeSession,
  roundChunks,
  textBlock,
} from './helpers.ts';

const TARGET = { provider: 'test', model: 'test-model' };

/** 一个 history 块：用户消息 + 一条 assistant（可选附带 skill）。 */
function block(user: number, skill?: string): string {
  const parts = [
    `<user_message index="${user}"><![CDATA[需求${user}]]></user_message>`,
    `<assistant index="${user + 1}"><![CDATA[${'处理过程'.repeat(40)}${user}]]></assistant>`,
  ];
  if (skill !== undefined) {
    parts.push(
      `<skill_content name="${skill}" index="${user + 1}"><skill_resources><![CDATA[res-${skill}]]></skill_resources><skill_instructions><![CDATA[ins-${skill}]]></skill_instructions></skill_content>`,
    );
  }
  return parts.join('\n');
}

/** 三个块的会话：前两块被归档、最后一块保留（阈值按全部块估算 token 设定）。 */
function threeBlockSession(skills: [string?, string?, string?] = []): {
  session: Session;
  threshold: number;
} {
  const session = makeSession({
    events: [
      historyMessage(block(0, skills[0]), 'h1'),
      historyMessage(block(2, skills[1]), 'h2'),
      historyMessage(block(4, skills[2]), 'h3'),
    ],
  });
  const { blocks } = historySection(session);
  const threshold = blocks.reduce((total, b) => total + estimateTextTokens(b.text), 0);
  return { session, threshold };
}

/** 归档轮：两个段各压成一句话后完成。 */
function archiveRound(): unknown[] {
  return roundChunks({
    calls: [
      {
        id: 'c1',
        name: 'compressHistory',
        args: { start: 1, end: 1, content: '完成需求0，改 a.ts', keywords: ['a.ts'] },
      },
      {
        id: 'c2',
        name: 'compressHistory',
        args: { start: 3, end: 3, content: '完成需求2，改 b.ts', keywords: ['b.ts'] },
      },
      { id: 'done', name: 'completeCompression' },
    ],
  });
}

/** 运行一次反思检查并等待后台任务结束。 */
async function startAndSettle(
  ctx: ReturnType<typeof makeCtx>,
  session: Session,
  threshold: number,
): Promise<void> {
  reflectPass(ctx, { session } as never, config(threshold), TARGET);
  await peekReflectJob(session.id)?.promise;
}

function config(threshold: number) {
  return resolveConfig({ reflectThresholdTokens: threshold, rateLimitWaitMs: 0, debug: true });
}

function eventTypes(session: Session): string[] {
  return session.snapshotEvents().map((event) => event.type);
}

afterEach(() => disposeAllReflections());

describe('selectArchiveBlocks', () => {
  it('从尾部累加保留合计不超过预算的块，其余归档', () => {
    const { archived, kept } = selectArchiveBlocks([5, 4, 3, 2], (n) => n, 5);
    expect(archived).toEqual([5, 4]);
    expect(kept).toEqual([3, 2]);
  });

  it('最后一块超出预算时仍至少保留 1 块', () => {
    const { archived, kept } = selectArchiveBlocks([1, 2, 30], (n) => n, 5);
    expect(archived).toEqual([1, 2]);
    expect(kept).toEqual([30]);
  });
});

describe('异步反思', () => {
  it('达到阈值后后台运行，不阻塞；完成后提交 archived-history，保留尾部块', async () => {
    const { session, threshold } = threeBlockSession();
    const ctx = makeCtx({ llmStreamFactory: () => archiveRound() });
    reflectPass(ctx, { session } as never, config(threshold), TARGET);
    const job = peekReflectJob(session.id);
    expect(job?.state).toBe('running');
    expect(job?.archived.map((b) => b.seq)).toEqual([0, 1]);
    expect(eventTypes(session)).not.toContain('compaction/start');

    await job?.promise;
    expect(job?.state).toBe('done');
    // 完成后未经提交，表层不变
    expect(historySection(session).blocks).toHaveLength(3);

    const skills = commitReflection(ctx, { session } as never, config(threshold));
    expect(skills).toEqual([]);
    const { blocks, archived } = historySection(session);
    expect(blocks.map((b) => b.text)).toEqual([expect.stringContaining('需求4')]);
    expect(archived).toHaveLength(1);
    const text = archived[0]?.text ?? '';
    expect(text).toContain('<user_message index="0"><![CDATA[需求0]]></user_message>');
    expect(text).toContain('key-word="a.ts"');
    expect(text).toContain('完成需求2，改 b.ts');
    expect(text).not.toContain('处理过程');
    const types = eventTypes(session);
    expect(types.filter((t) => t.startsWith('compaction/'))).toEqual([
      'compaction/start',
      'compaction/summary',
      'compaction/end',
    ]);
    expect(peekReflectJob(session.id)).toBeUndefined();
  });

  it('同一会话最多一个任务：运行中再次检查不重复启动', async () => {
    const { session, threshold } = threeBlockSession();
    const ctx = makeCtx({ llmStreamFactory: () => archiveRound() });
    reflectPass(ctx, { session } as never, config(threshold), TARGET);
    const job = peekReflectJob(session.id);
    reflectPass(ctx, { session } as never, config(threshold), TARGET);
    expect(peekReflectJob(session.id)).toBe(job);
    await job?.promise;
    // 待提交期间同样不重复启动
    reflectPass(ctx, { session } as never, config(threshold), TARGET);
    expect(peekReflectJob(session.id)).toBe(job);
    expect(ctx._llmCalls).toHaveLength(1);
  });

  it('低于阈值或只有 1 个块时不启动', () => {
    const { session, threshold } = threeBlockSession();
    const ctx = makeCtx({ llmStreamFactory: () => archiveRound() });
    reflectPass(ctx, { session } as never, config(threshold + 1), TARGET);
    expect(peekReflectJob(session.id)).toBeUndefined();

    const single = makeSession({ events: [historyMessage(block(0), 'h1')] });
    reflectPass(ctx, { session: single } as never, config(1), TARGET);
    expect(peekReflectJob(single.id)).toBeUndefined();
  });

  it('被归档块提取的 skill 以 skill-invocation 消息注入，同名保留最新，保留块已有的不注入', async () => {
    const { session, threshold } = threeBlockSession(['alpha', 'alpha', 'beta']);
    const ctx = makeCtx({ llmStreamFactory: () => archiveRound() });
    await startAndSettle(ctx, session, threshold);
    const skills = commitReflection(ctx, { session } as never, config(threshold));
    expect(skills).toHaveLength(1);
    const message = skills[0];
    expect(message?.source).toEqual({
      kind: SKILL_INVOCATION_KIND,
      name: 'alpha',
      form: 'instructions',
    });
    expect(message?.content).toEqual([
      textBlock(
        '<skill_content name="alpha"><skill_resources>res-alpha</skill_resources>\n\n<skill_instructions>ins-alpha</skill_instructions></skill_content>',
      ),
    ]);
    expect(historySection(session).archived[0]?.text).not.toContain('skill_content');
  });

  it('提交前被归档块已不在表层：丢弃结果，不写 compaction 事件', async () => {
    const { session, threshold } = threeBlockSession();
    const ctx = makeCtx({ llmStreamFactory: () => archiveRound() });
    await startAndSettle(ctx, session, threshold);
    // 模拟后台运行期间第一个块被替换
    session.append('user/message', makeMessage({ content: [textBlock('替换')] }) as never, {
      surfaceOp: { op: 'replace', startSeq: 0 as never, endSeq: 0 as never },
      sourceEventSeqs: [0 as never],
    });
    expect(commitReflection(ctx, { session } as never, config(threshold))).toEqual([]);
    expect(eventTypes(session)).not.toContain('compaction/start');
    expect(peekReflectJob(session.id)).toBeUndefined();
  });

  it('失败：下次检查记录 start + end(error)；块集合不变不重试，出现新块后重试', async () => {
    const { session, threshold } = threeBlockSession();
    const ctx = makeCtx({ llmStreamFactory: () => roundChunks({ text: '不调用工具' }) });
    await startAndSettle(ctx, session, threshold);
    expect(peekReflectJob(session.id)?.state).toBe('failed');
    const calls = ctx._llmCalls.length;

    reflectPass(ctx, { session } as never, config(threshold), TARGET);
    const end = session.snapshotEvents().find((e) => e.type === 'compaction/end');
    expect((end?.data as { error?: string } | undefined)?.error).toContain('未调用压缩工具');
    expect(peekReflectJob(session.id)).toBeUndefined();

    reflectPass(ctx, { session } as never, config(threshold), TARGET);
    expect(peekReflectJob(session.id)).toBeUndefined();
    expect(ctx._llmCalls).toHaveLength(calls);

    session.append('user/message', historyMessage(block(6), 'h4').data as never, {
      surfaceOp: 'append',
    });
    reflectPass(ctx, { session } as never, config(threshold), TARGET);
    expect(peekReflectJob(session.id)?.state).toBe('running');
  });
});

describe('反思阈值按换算系数折算真实 token', () => {
  /** 全部日志文本（各级别）。 */
  const logs = (ctx: ReturnType<typeof makeCtx>): string[] =>
    ctx._loggerCalls.map((call) => String(call.args[0]));

  it('换算系数 2：估算 × 2 达阈值触发归档', () => {
    const { session, threshold: estimated } = threeBlockSession();
    // 真实用量基线 = 2 × 表层估算 → 换算系数 2.00
    const ctx = makeCtx({
      meterTotalTokens: 2 * estimated,
      meterSurfaceTokens: estimated,
      llmStreamFactory: () => archiveRound(),
    });
    reflectPass(ctx, { session } as never, config(2 * estimated), TARGET);
    expect(peekReflectJob(session.id)?.state).toBe('running');
    expect(
      logs(ctx).some((s) =>
        s.includes(
          `${2 * estimated} tokens（估算 ${estimated} × 换算系数 2.00） ≥ 阈值 ${2 * estimated}`,
        ),
      ),
    ).toBe(true);
  });

  it('换算系数 2：估算 × 2 仍低于阈值则跳过', () => {
    const { session, threshold: estimated } = threeBlockSession();
    const ctx = makeCtx({
      meterTotalTokens: 2 * estimated,
      meterSurfaceTokens: estimated,
      llmStreamFactory: () => roundChunks({ text: '不应被调用' }),
    });
    reflectPass(ctx, { session } as never, config(2 * estimated + 1), TARGET);
    expect(peekReflectJob(session.id)).toBeUndefined();
    expect(ctx._llmCalls).toHaveLength(0);
    expect(
      logs(ctx).some((s) =>
        s.includes(
          `${2 * estimated} tokens（估算 ${estimated} × 换算系数 2.00） < 阈值 ${2 * estimated + 1}，跳过`,
        ),
      ),
    ).toBe(true);
  });
});

describe('归档保留已处理问答', () => {
  it('只含 q/a 的 ask 原样保留，不提供 rewriteAskUserQuestion', async () => {
    const ask =
      '<ask-user-question index="0"><![CDATA[q:采用哪种发布方式？\na:采用灰度发布，先向少量用户开放。]]></ask-user-question>';
    const session = makeSession({
      events: [historyMessage(ask, 'h1'), historyMessage(block(1), 'h2')],
    });
    const ctx = makeCtx({
      llmStreamFactory: () => roundChunks({ calls: [{ id: 'done', name: 'completeCompression' }] }),
    });
    await startAndSettle(ctx, session, 1);
    expect(JSON.stringify(ctx._llmCalls[0]?.options)).not.toContain('rewriteAskUserQuestion');
    commitReflection(ctx, { session } as never, config(1));
    const text = historySection(session).archived[0]?.text ?? '';
    expect(text).toContain(ask);
    expect(text).not.toContain('o1:');
  });
});

describe('反思失败：诊断子会话 id', () => {
  it('compaction/end(error) 载荷携带诊断子会话 sessionId，表层不变', async () => {
    const { session, threshold } = threeBlockSession();
    const ctx = makeCtx({ llmStreamFactory: () => roundChunks({ text: '不调用压缩工具' }) });
    await startAndSettle(ctx, session, threshold);
    const created = ctx._createdSessions[0];
    expect(created).toBeDefined();
    expect(peekReflectJob(session.id)?.failure?.diagnosticSessionId).toBe(created?.id);
    reflectPass(ctx, { session } as never, config(threshold), TARGET);
    const end = session.snapshotEvents().find((e) => e.type === 'compaction/end');
    const data = (end?.data as { error?: string; diagnosticSessionId?: string } | undefined) ?? {};
    expect(data.error).toContain('未调用压缩工具');
    expect(data.diagnosticSessionId).toBe(created?.id);
    expect(historySection(session).blocks).toHaveLength(3);
  });
});
