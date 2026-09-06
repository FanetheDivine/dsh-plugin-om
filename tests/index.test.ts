// index.ts（插件入口）apply 接线的集成级单元测试：OM 观察压缩与增量追加、反思压缩、
// compaction 生命周期与 checkpoint 标记、摘要 token 归入、摘要请求形态、
// recall/semanticRecall 工具开关与 ensureModelReady 预热。
import { describe, expect, it, vi } from 'vitest';

// 隔离 apply 的模型下载编排：ensureModelReady 打桩为"就绪"，避免单测触发真实下载/网络
vi.mock('../src/embedding.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/embedding.ts')>();
  return {
    ...actual,
    ensureModelReady: vi.fn(async () => 'ready' as const),
  };
});

import { buildCompressionPrompt } from '../src/compress-loop.ts';
import { HISTORY_FORMAT_NOTE, PLUGIN_LABEL } from '../src/constants.ts';
import { ensureModelReady } from '../src/embedding.ts';
import { apply } from '../src/index.ts';
import { findOmEvents } from '../src/om-event.ts';
import type { CompactionSummaryPayload, Session, SessionEvent, UserMessage } from '../src/types.ts';
import {
  buildToolCallFlow,
  checkpointSourceOf,
  compactionLifecycle,
  historyMessage,
  isOmKind,
  latestHistoryText,
  makeCtx,
  makeMessage,
  makeOmEvent,
  makeSession,
  roundChunks,
  textBlock,
} from './helpers.ts';

/**
 * 构造一段成功完成压缩的工具轮脚本（供 llmStreamFactory 逐轮产出）：
 * 第 1 轮 getHistory，第 2 轮 compressHistory（按分区压缩），第 3 轮 completeCompression。
 */
function successRoundFactory(calls: Array<{ id: string; name: string; args?: unknown }>) {
  return (index: number) => {
    if (index === 0) return roundChunks({ calls: [{ id: 'g1', name: 'getHistory' }] });
    if (index === 1) return roundChunks({ calls });
    return roundChunks({ calls: [{ id: 'c9', name: 'completeCompression' }] });
  };
}

/**
 * 延迟压缩两步执行：第一次 pre-step 触发观察（记录待定标记），随后追加一条等待期
 * 用户消息跨过延迟窗口（新增完整消息数达到 tailMessageCount），第二次 pre-step 执行压缩。
 */
async function runPreStepWithDelay(
  ctx: ReturnType<typeof makeCtx>,
  session: Session,
): Promise<void> {
  const listeners = ctx._onCallbacks.get('agent/pre-step');
  const run = () =>
    listeners?.[0]?.({ agent: { session }, signal: new AbortController().signal }, () => {});
  await run(); // 第一步：触发观察，记录待定标记（无摘要调用）
  session.append(
    'user/message',
    makeMessage({
      content: [textBlock('延迟等待期的新消息')],
      id: `wait-${session.events.length}`,
    }) as unknown as UserMessage,
    { surfaceOp: 'append' },
  );
  await run(); // 第二步：新增完整消息数达到 tailMessageCount → 执行压缩
}

/** 构造 om/observe-pending 信封事件（seq 由 makeSession 按日志下标补齐）。 */
function pendingEvent(triggerMessageIndex: number): SessionEvent {
  return makeOmEvent('om/observe-pending', { triggerMessageIndex });
}

describe('apply 接线（OM 观察压缩）', () => {
  /** 运行 pre-step 监听器（阻塞等待压缩完成），返回 next 是否被调用。 */
  async function runPreStep(ctx: ReturnType<typeof makeCtx>, session: Session) {
    const preStepListeners = ctx._onCallbacks.get('agent/pre-step');
    let nextCalled = false;
    const next = () => {
      nextCalled = true;
    };
    await preStepListeners?.[0]?.(
      { agent: { session }, signal: new AbortController().signal },
      next,
    );
    return nextCalled;
  }

  /** 取一次摘要调用（llm.stream）的请求选项。 */
  function summaryOptions(ctx: ReturnType<typeof makeCtx>, index = 0) {
    return ctx._llmCalls[index]?.options as {
      system?: string;
      messages?: Array<{
        role?: string;
        content?: Array<{ type?: string; text?: string }>;
      }>;
      maxTokens?: number;
    };
  }

  /** 提取摘要指令文本（new 方式：指令在 system 字段）。 */
  function instructionText(options: ReturnType<typeof summaryOptions>): string {
    return String(options.system ?? '');
  }

  /** 返回按成功脚本执行压缩循环的 ctx（观察阈值需在 apply 配置中触发）。 */
  function observeCtx(
    compressCalls: Array<{ id: string; name: string; args?: unknown }> = [
      {
        id: 't2',
        name: 'compressHistory',
        args: {
          start: 1,
          end: 2,
          content: 'toolcall index:2 purpose:跑一下 summary:产物符合预期；下一步提交',
        },
      },
    ],
  ) {
    return makeCtx({
      llmStreamFactory: successRoundFactory(compressCalls),
    });
  }

  it('触发观察：压缩循环 → 追加为 <history>，替换被压缩区间', async () => {
    const flowEvents = buildToolCallFlow({
      code: 'runMe()',
      description: '跑一下',
      callId: 'c-eval',
      resultText: 'done',
      withTurnEnd: true,
    });
    const session = makeSession({ events: flowEvents });
    const ctx = observeCtx();
    apply(ctx, { tailMessageCount: 0, observeThresholdTokens: 1 });

    expect(ctx._sections).toHaveLength(0);
    expect(ctx._registeredTools.some((t) => t.name === 'recall')).toBe(true);
    expect(ctx._registeredTools.some((t) => t.name === 'recall-semantic')).toBe(true);
    const sessionListeners = ctx._onCallbacks.get('session/event');
    expect(sessionListeners).toBeUndefined(); // 不监听 session/event

    const nextCalled = await runPreStep(ctx, session);
    expect(nextCalled).toBe(true); // 阻塞执行后放行
    expect(ctx._llmCalls).toHaveLength(3); // getHistory → compressHistory → completeCompression
    const options = summaryOptions(ctx);
    // 工具循环：共享提示词并入 system；首条 user 消息 = 压缩指令 + 区间（不含历史内容）
    const instruction = instructionText(options);
    expect(instruction).toBe(buildCompressionPrompt(true)); // 共享提示词（观察/反思同一套）
    expect(options.system).toBe(instruction);
    expect(options.maxTokens).toBeUndefined(); // compressMaxTokens 默认不设置

    const historyText = latestHistoryText(session);
    // 新格式：<user_message index> 完整原文 + <assistant start..end> 聚合模块；格式说明注释在块首
    expect(historyText).toContain('<user_message index="0">');
    expect(historyText).toContain('请帮我完成一个任务');
    expect(historyText).toContain('<assistant start="1" end="2">');
    expect(historyText).toContain(
      'toolcall index:2 purpose:跑一下 summary:产物符合预期；下一步提交',
    );
    expect(historyText).toContain('完整消息：'); // HISTORY_FORMAT_NOTE 注释（完整消息定义串）
    // 遮蔽后表层 = 仅 <history> 块（tailCount=0 全部压缩）
    expect(session.surface.nodes.length).toBe(1);
    // compaction 生命周期：start → summary → 替换消息 → end（同 compactionId）
    const { start, summary, end, replace } = compactionLifecycle(session);
    expect(start).not.toBe(-1);
    expect(summary).toBe(start + 1);
    expect(replace).toBe(summary + 1);
    expect(end).toBe(replace + 1);
    // 不再单独发 compaction/prune（summary 承担影子价格认领）
    expect(session.events.some((e) => e.type === 'compaction/prune')).toBe(false);
    const startEvent = session.events[start];
    const summaryEvent = session.events[summary];
    const endEvent = session.events[end];
    const replaceEvent = session.events[replace];
    if (startEvent?.type !== 'compaction/start') throw new Error('缺 start');
    if (summaryEvent?.type !== 'compaction/summary') throw new Error('缺 summary');
    if (endEvent?.type !== 'compaction/end') throw new Error('缺 end');
    const compactionId = startEvent.data.compactionId;
    expect(summaryEvent.data.compactionId).toBe(compactionId);
    expect(endEvent.data.compactionId).toBe(compactionId);
    // start 携带压缩阶段（UI 压缩中提示按阶段区分文案）；3 轮请求 → attemptCount=3
    expect((startEvent.data as { phase?: string }).phase).toBe('observe');
    expect((summaryEvent.data as CompactionSummaryPayload).attemptCount).toBe(3);
    // summary 内容 = 完整合并后的 <history> 内文（聊天卡片所见即所得）
    const summaryText = summaryEvent.data.summary
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    expect(summaryText).toContain('<user_message index="0">');
    expect(summaryText).toContain(
      'toolcall index:2 purpose:跑一下 summary:产物符合预期；下一步提交',
    );
    // 替换消息 source = 插件标识（plugin: PLUGIN_LABEL + compactionId）
    const source = checkpointSourceOf(replaceEvent);
    expect(source?.kind).toBe('plugin');
    expect(source?.plugin).toBe(PLUGIN_LABEL);
    expect(source?.compactionId).toBe(compactionId);
    expect(session.surface.replaceGeneration).toBeGreaterThanOrEqual(1);
    // 统计载荷：遮蔽节点 = 整条工具流（user/assistant/tool-result）；压缩前字符数 = 9+6+4（递归计入 tool-result 内嵌文本）
    expect(summaryEvent.data.shadowedSeqs).toEqual([0, 1, 3]);
    expect((summaryEvent.data as CompactionSummaryPayload).shadowedCharCount).toBe(19);
    // 成功落盘压缩会话记录子会话（label 为会话记录）
    expect(ctx._createdSessions).toHaveLength(1);
    const descriptor = ctx._createdSessions[0]?.session.events.find(
      (e) => e.type === 'subagent/descriptor',
    );
    expect((descriptor?.data as { label?: string })?.label).toContain('会话记录');
  });

  it('compressSkipReasoning=false：压缩指令携带 <reasoning> 说明行，getHistory 输出含参考条目', async () => {
    const flowEvents = buildToolCallFlow({
      code: 'runMe()',
      description: '跑一下',
      callId: 'c-eval',
      resultText: 'done',
      withTurnEnd: true,
    });
    // assistant 消息携带 reasoning 块（参考条目数据源）
    const withReasoning = flowEvents.map((event) => {
      if (event.type !== 'assistant/message') return event;
      const message = (event.data as { message?: { content?: unknown[] } }).message;
      if (!message) return event;
      message.content = [{ type: 'reasoning', text: '先想再答' }, ...(message.content ?? [])];
      return event;
    });
    const session = makeSession({ events: withReasoning });
    const ctx = observeCtx();
    apply(ctx, { tailMessageCount: 0, observeThresholdTokens: 1, compressSkipReasoning: false });
    const nextCalled = await runPreStep(ctx, session);
    expect(nextCalled).toBe(true);
    // 压缩指令包含 <reasoning> 说明行（skipReasoning=false）
    expect(instructionText(summaryOptions(ctx))).toBe(buildCompressionPrompt(false));
    // 最终 <history> 块不含 reasoning（参考条目不进产物）
    expect(latestHistoryText(session)).not.toContain('<reasoning>');
  });

  it('系统消息参与压缩：视图含 <sys> 空块，最终 <history> 保留 sys 条目', async () => {
    const sysText = '遵循如下工作区指令：先阅读 README.md。';
    const session = makeSession({
      events: [
        {
          type: 'user/message',
          data: makeMessage({
            content: [textBlock(sysText)],
            source: { kind: 'agent-instructions', form: 'instructions' },
            id: 'sys-instr',
          }),
        } as unknown as SessionEvent,
        ...buildToolCallFlow({
          code: 'runMe()',
          description: '跑一下',
          callId: 'c-eval',
          resultText: 'done',
          withTurnEnd: true,
        }),
      ],
    });
    const ctx = observeCtx([
      {
        id: 't2',
        name: 'compressHistory',
        args: { start: 2, end: 3, content: 'toolcall index:3 purpose:跑一下 summary:产物符合预期' },
      },
    ]);
    apply(ctx, { tailMessageCount: 0, observeThresholdTokens: 1 });
    await runPreStep(ctx, session);
    // 首条 user 消息为压缩指令 + 区间，不含历史内容；系统消息不进入指令
    const options = summaryOptions(ctx);
    const taskText = String(options.messages?.[0]?.content?.[0]?.text ?? '');
    expect(taskText).toContain('[0..3]');
    expect(taskText).not.toContain(sysText);
    // 压缩成功；<history> 块含 sys 空块（不可压缩条目原样保留）
    expect(ctx._llmCalls).toHaveLength(3);
    const historyText = latestHistoryText(session);
    expect(historyText).toContain('<sys type="agent-instructions" index="0"></sys>');
  });

  it('系统消息不可压缩：compressHistory 覆盖 sys 条目时工具报错，循环继续', async () => {
    const session = makeSession({
      events: [
        {
          type: 'user/message',
          data: makeMessage({
            content: [textBlock('遵循如下工作区指令：先阅读 README.md。')],
            source: { kind: 'agent-instructions', form: 'instructions' },
            id: 'sys-instr',
          }),
        } as unknown as SessionEvent,
        ...buildToolCallFlow({
          code: 'runMe()',
          description: '跑一下',
          callId: 'c-eval',
          resultText: 'done',
          withTurnEnd: true,
        }),
      ],
    });
    // 第 2 轮先尝试覆盖 sys（报错），同轮再压缩合法区间 → 成功
    const ctx = makeCtx({
      llmStreamFactory: (index) => {
        if (index === 0) return roundChunks({ calls: [{ id: 'g1', name: 'getHistory' }] });
        if (index === 1)
          return roundChunks({
            calls: [
              { id: 't1', name: 'compressHistory', args: { start: 0, end: 3, content: 'x' } },
              {
                id: 't2',
                name: 'compressHistory',
                args: { start: 2, end: 3, content: '合法压缩' },
              },
            ],
          });
        return roundChunks({ calls: [{ id: 'c9', name: 'completeCompression' }] });
      },
    });
    apply(ctx, { tailMessageCount: 0, observeThresholdTokens: 1 });
    await runPreStep(ctx, session);
    // 报错的工具结果进入下一轮请求：第三轮请求含「系统消息不可压缩」
    const third = ctx._llmCalls[2];
    expect(JSON.stringify(third?.options)).toContain('系统消息不可压缩');
    const historyText = latestHistoryText(session);
    expect(historyText).toContain('<sys type="agent-instructions" index="0"></sys>');
    expect(historyText).toContain('合法压缩');
  });

  it('增量追加：旧摘要消息原地保留，新观察日志作为独立消息只替换新消息区间', async () => {
    const flowEvents = buildToolCallFlow({
      code: 'a()',
      description: '任务A',
      callId: 'c1',
      resultText: 'r1',
      withTurnEnd: true,
    });
    const session = makeSession({
      events: [historyMessage('user_message message_id:old-u text:旧任务'), ...flowEvents],
    });
    // 观察阈值 1 tokens ≤ 上下文压力（触发）；反思阈值 1000 > 旧摘要
    // （含 tip 开标签约 26 tokens，不触发）——隔离观察路径验证增量追加
    const ctx = observeCtx([
      {
        id: 't2',
        name: 'compressHistory',
        args: { start: 1, end: 2, content: 'toolcall index:2 purpose:任务A summary:完成' },
      },
    ]);
    apply(ctx, { tailMessageCount: 1, observeThresholdTokens: 1, reflectThresholdTokens: 1000 });
    await runPreStepWithDelay(ctx, session);
    // 表层中的压缩日志消息：旧块（seq 0，保留） + 新块（独立消息，替换压缩区间）
    const historyMsgs = session.surface.nodes
      .map((seq) => session.events[seq])
      .filter(
        (e): e is SessionEvent =>
          e?.type === 'user/message' &&
          String(
            ((e.data as { source?: unknown }).source as { kind?: string } | undefined)?.kind,
          ) === 'plugin',
      );
    expect(historyMsgs).toHaveLength(2);
    const texts = historyMsgs.map((e) =>
      String(
        ((e.data as { content?: unknown[] }).content?.[0] as { text?: string } | undefined)?.text ??
          '',
      ),
    );
    expect(texts[0]).toContain('旧任务'); // 旧块原文保留
    expect(texts[0]).not.toContain('请帮我完成一个任务'); // 旧块不被重写
    expect(texts[1]).toContain('请帮我完成一个任务'); // 新块含未压缩 user 原文（视图原样保留）
    expect(texts[1]).not.toContain('旧任务'); // 新块不再合并旧摘要原文
    // 新块替换压缩边界至触发点区间（seq 1..4；旧块 seq 0 在边界之前、不被遮蔽；
    // 等待期新消息在触发点之后、不在压缩区间内）
    const newBlock = historyMsgs[1] as unknown as {
      surfaceOp: { op: string; start: number; end: number };
      shadowedSeqs?: number[];
    };
    expect(newBlock.surfaceOp).toEqual({ op: 'replace', start: 1, end: 4 });
    expect(newBlock.shadowedSeqs).toEqual([1, 2, 4]);
    // 表层 = 旧块 + 等待期新消息 + 新块
    expect(session.surface.nodes.length).toBe(3);
  });

  it('未达观察阈值不压缩（无摘要调用、无 <history>）', async () => {
    const session = makeSession({
      events: buildToolCallFlow({
        code: 'a()',
        description: '任务A',
        callId: 'c1',
        resultText: 'r1',
        withTurnEnd: true,
      }),
    });
    const ctx = makeCtx({});
    apply(ctx, {}); // 默认观察阈值 45000 tokens，未达不压缩
    await runPreStep(ctx, session);
    expect(ctx._llmCalls).toHaveLength(0);
    expect(latestHistoryText(session)).toBe('');
    expect(session.surface.nodes.length).toBe(3);
  });

  it('模型输出纯文本（无工具调用）：追加提醒继续，连续 2 轮判失败不产生替换', async () => {
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
      llmStreamFactory: () => roundChunks({ text: '我认为不需要压缩' }),
    });
    apply(ctx, { tailMessageCount: 1, observeThresholdTokens: 1 });
    await runPreStepWithDelay(ctx, session);
    // 第 1 轮纯文本 → 提醒；第 2 轮仍纯文本 → 判失败（共 2 次请求）
    expect(ctx._llmCalls).toHaveLength(2);
    // 压缩失败保留待定标记（无失效标记）：下个 pre-step 直接重试执行
    expect(session.events.some((e) => isOmKind(e, 'om/observe-pending'))).toBe(true);
    expect(session.events.some((e) => isOmKind(e, 'om/observe-invalidate'))).toBe(false);
    // 压缩失败：start 在循环前已开启（UI 压缩中提示），end(error) 关闭生命周期；
    // 无 summary、无部分替换
    expect(session.events.some((e) => e.type === 'compaction/start')).toBe(true);
    expect(session.events.some((e) => e.type === 'compaction/summary')).toBe(false);
    const failEnd = session.events.findLast((e) => e.type === 'compaction/end');
    if (failEnd?.type !== 'compaction/end') throw new Error('缺 end');
    expect((failEnd.data as { error?: string }).error).toContain('未调用压缩工具');
    expect(latestHistoryText(session)).toBe(''); // 无部分替换
    // 失败也落盘会话记录（label 为失败日志）
    const descriptor = ctx._createdSessions[0]?.session.events.find(
      (e) => e.type === 'subagent/descriptor',
    );
    expect((descriptor?.data as { label?: string })?.label).toContain('失败日志');
  });

  it('请求级错误：流以 error 终态结束视为失败，不产生替换', async () => {
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
      llmStreamFactory: () =>
        roundChunks({ finish: { kind: 'error', failure: { message: '额度不足' } } }),
    });
    apply(ctx, { tailMessageCount: 1, observeThresholdTokens: 1 });
    await runPreStepWithDelay(ctx, session);
    // 请求级错误不重试：仅 1 次请求即失败
    expect(ctx._llmCalls).toHaveLength(1);
    expect(session.events.some((e) => e.type === 'compaction/start')).toBe(true);
    expect(session.events.some((e) => e.type === 'compaction/end')).toBe(true);
    expect(session.events.some((e) => e.type === 'compaction/summary')).toBe(false);
    expect(latestHistoryText(session)).toBe('');
  });

  it('压缩循环失败：pre-step 返回 reject 中断当前 turn（不调用 next），end(error) 携带实际报错', async () => {
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
      llmStreamFactory: () =>
        roundChunks({ finish: { kind: 'error', failure: { message: '额度不足' } } }),
    });
    apply(ctx, { tailMessageCount: 1, observeThresholdTokens: 1 });
    const listeners = ctx._onCallbacks.get('agent/pre-step');
    let nextCalled = false;
    const run = () =>
      listeners?.[0]?.({ agent: { session }, signal: new AbortController().signal }, () => {
        nextCalled = true;
        return undefined;
      });
    await run(); // 第一步：触发观察，记录待定标记（正常放行）
    nextCalled = false;
    session.append(
      'user/message',
      makeMessage({
        content: [textBlock('延迟等待期的新消息')],
        id: 'wait-reject',
      }) as unknown as UserMessage,
      { surfaceOp: 'append' },
    );
    const decision = await run(); // 第二步：延迟到期执行，压缩失败拒绝本 step
    expect(decision).toEqual({ kind: 'reject' }); // 拒绝本 step，当前 turn 以 blocked 结束
    expect(nextCalled).toBe(false); // 不放行、不再继续 AI 会话
    expect(ctx._llmCalls).toHaveLength(1);
    const failEnd = session.events.findLast((e) => e.type === 'compaction/end');
    if (failEnd?.type !== 'compaction/end') throw new Error('缺 end');
    expect((failEnd.data as { error?: string }).error).toContain('额度不足'); // 实际报错写入 end
    // 诊断子会话（失败日志）id 随 end 载荷传播
    expect((failEnd.data as { diagnosticSessionId?: string }).diagnosticSessionId).toBe(
      ctx._createdSessions[0]?.id,
    );
    const warns = ctx._loggerCalls.filter((c) => c.level === 'warn').map((c) => String(c.args[0]));
    expect(
      warns.some((w) => w.includes('上下文压缩失败，拒绝本 step 中断当前 turn：额度不足')),
    ).toBe(true);
  });

  it('压缩失败后下个 pre-step 重试成功：保留待定直接重试执行', async () => {
    const session = makeSession({
      events: buildToolCallFlow({
        code: 'a()',
        description: '任务A',
        callId: 'c1',
        resultText: 'r1',
        withTurnEnd: true,
      }),
    });
    // 第 1 次执行失败（请求抛错）；第 2 次执行成功完成压缩（3 轮）
    let failed = true;
    const successCalls: Array<{ id: string; name: string; args?: unknown }> = [
      {
        id: 't2',
        name: 'compressHistory',
        args: { start: 1, end: 2, content: 'toolcall index:2 purpose:任务A summary:完成' },
      },
    ];
    const ctx = makeCtx({
      llmStreamFactory: (index) => {
        if (failed) {
          if (index === 0) return roundChunks({ calls: [{ id: 'g1', name: 'getHistory' }] });
          return roundChunks({ finish: { kind: 'error', failure: { message: '第一次失败' } } });
        }
        if (index === 0) return roundChunks({ calls: [{ id: 'g1', name: 'getHistory' }] });
        if (index === 1) return roundChunks({ calls: successCalls });
        return roundChunks({ calls: [{ id: 'c9', name: 'completeCompression' }] });
      },
    });
    apply(ctx, { tailMessageCount: 1, observeThresholdTokens: 1 });
    const listeners = ctx._onCallbacks.get('agent/pre-step');
    const run = () =>
      listeners?.[0]?.({ agent: { session }, signal: new AbortController().signal }, () => {});
    await run(); // 触发：记录待定
    session.append(
      'user/message',
      makeMessage({ content: [textBlock('等待期消息1')], id: 'w1' }) as unknown as UserMessage,
      { surfaceOp: 'append' },
    );
    await run(); // 执行：失败（getHistory 后请求 error）
    failed = false;
    await run(); // 待定保留：直接重试执行 → 成功
    expect(session.events.some((e) => e.type === 'compaction/summary')).toBe(true);
    expect(session.events.some((e) => isOmKind(e, 'om/observe-invalidate'))).toBe(true);
    expect(latestHistoryText(session)).toContain('请帮我完成一个任务');
  });

  it('signal 已中止：放弃压缩但不拒绝（照常放行 next）', async () => {
    const session = makeSession({
      events: buildToolCallFlow({
        code: 'a()',
        description: '任务A',
        callId: 'c1',
        resultText: 'r1',
        withTurnEnd: true,
      }),
    });
    const ctx = observeCtx();
    apply(ctx, { tailMessageCount: 1, observeThresholdTokens: 1 });
    const controller = new AbortController();
    controller.abort();
    const listeners = ctx._onCallbacks.get('agent/pre-step');
    let nextCalled = false;
    const decision = await listeners?.[0]?.(
      { agent: { session }, signal: controller.signal },
      () => {
        nextCalled = true;
        return undefined;
      },
    );
    expect(decision).toBeUndefined(); // next() 的返回值（放行）
    expect(nextCalled).toBe(true);
    expect(ctx._llmCalls).toHaveLength(0); // 中止时不发起压缩请求
  });

  it('中断不注入观察指令（AI 自主判断，无中断标记）', async () => {
    const flowEvents = buildToolCallFlow({
      code: 'a()',
      description: '任务A',
      callId: 'c1',
      resultText: 'r1',
      withTurnEnd: true,
      turnEndReason: { kind: 'aborted', reason: { kind: 'user' } },
    });
    const session = makeSession({ events: flowEvents });
    const ctx = observeCtx();
    apply(ctx, { tailMessageCount: 1, observeThresholdTokens: 1 });
    await runPreStepWithDelay(ctx, session);
    const instruction = instructionText(summaryOptions(ctx));
    expect(instruction).not.toContain('[interrupted]');
  });

  it('当前 turn 消息可压缩：mid-turn 压缩后其消息被替换、视图区间覆盖当前 turn 消息', async () => {
    const events = [
      ...buildToolCallFlow({
        code: 'a()',
        description: '任务A',
        callId: 'c1',
        resultText: 'r1',
        withTurnEnd: true,
      }),
      ...buildToolCallFlow({
        code: 'b()',
        description: '任务B',
        callId: 'c2',
        resultText: 'r2',
        userMessageId: 'user-c2',
        assistantMessageId: 'assistant-c2',
        resultMessageId: 'result-c2',
      }),
    ];
    const session = makeSession({ events }); // 表层 [0,1,3,5,6,8]
    const ctx = observeCtx([
      {
        id: 't2',
        name: 'compressHistory',
        args: { start: 1, end: 5, content: 'A-模块摘要' },
      },
    ]);
    apply(ctx, { tailMessageCount: 1, observeThresholdTokens: 1 });
    await runPreStepWithDelay(ctx, session);
    // 区间截至触发点（完整消息 index 5，最后事件 seq 8 平衡）：mid-turn 消息一并压缩；
    // 等待期新消息在触发点之后、不被压缩
    const nodes = session.surface.nodes;
    expect(nodes.length).toBe(2); // 等待期新消息 + <history>
    // 压缩指令携带视图区间：新消息（含当前 turn 的 user-c2）从 0 编号
    const instruction = instructionText(summaryOptions(ctx));
    const taskText = String(summaryOptions(ctx)?.messages?.[0]?.content?.[0]?.text ?? '');
    expect(taskText).toContain('[0..5]');
    expect(instruction).not.toContain('message_id'); // 不再携带对照表
  });

  it('subagent 会话不压缩（主会话守卫）', async () => {
    const session = makeSession({
      events: buildToolCallFlow({
        code: 'a()',
        description: '任务A',
        callId: 'c1',
        resultText: 'r1',
        withTurnEnd: true,
      }),
      header: { origin: 'subagent' },
    });
    const ctx = makeCtx({});
    apply(ctx, {});
    await runPreStep(ctx, session);
    expect(ctx._llmCalls).toHaveLength(0);
    expect(session.surface.nodes.length).toBe(3);
  });

  it('omEnabled=false：关闭自动压缩（无摘要调用、无替换、recall 工具仍注册）', async () => {
    const session = makeSession({
      events: [
        historyMessage('旧任务'),
        ...buildToolCallFlow({
          code: 'a()',
          description: '任务A',
          callId: 'c1',
          resultText: 'r1',
          withTurnEnd: true,
        }),
      ],
    });
    const ctx = makeCtx({});
    apply(ctx, { omEnabled: false });
    // 工具注册不受影响（recall 独立开关）
    expect(ctx._registeredTools.some((t) => t.name === 'recall')).toBe(true);
    await runPreStep(ctx, session);
    // 观察/反思均不触发：无摘要调用、无 compaction 生命周期、表层不变
    expect(ctx._llmCalls).toHaveLength(0);
    expect(session.events.some((e) => e.type === 'compaction/start')).toBe(false);
    expect(session.surface.nodes.length).toBe(4); // 旧日志 + flow 3 条
    const steps = ctx._loggerCalls.filter((c) => c.level === 'debug').map((c) => String(c.args[0]));
    expect(steps.some((s) => s.includes('omEnabled=false，跳过压缩'))).toBe(true);
  });
});

describe('apply 接线（OM 反思压缩）', () => {
  /** 运行 pre-step 监听器并返回摘要调用记录。 */
  async function runPreStep(ctx: ReturnType<typeof makeCtx>, session: Session) {
    const preStepListeners = ctx._onCallbacks.get('agent/pre-step');
    await preStepListeners?.[0]?.(
      { agent: { session }, signal: new AbortController().signal },
      () => {},
    );
  }

  /** 提取摘要指令文本（new 方式：指令在 system 字段）。 */
  function instructionText(options: unknown): string {
    const o = options as { system?: string };
    return String(o.system ?? '');
  }

  /** 提取摘要调用的 user 输入文本（渲染消息，唯一 user 消息的首个 text 块）。 */
  function inputText(ctx: ReturnType<typeof makeCtx>): string {
    const call = ctx._llmCalls[0] as
      | { options?: { messages?: Array<{ content?: Array<{ text?: string }> }> } }
      | undefined;
    return String(call?.options?.messages?.[0]?.content?.[0]?.text ?? '');
  }

  it('摘要超反思阈值：压缩循环合并块区段并替换为一条', async () => {
    // 单块摘要（条目 + tip 标签约 30 tokens）；反思阈值 1 → 触发反思；
    // 上下文压力远小于观察阈值（保持默认 45000）→ 观察不触发
    const session = makeSession({
      events: [
        historyMessage(`<assistant index="0">${'X'.repeat(40)}</assistant>`),
        ...buildToolCallFlow({
          code: 'a()',
          description: '任务A',
          callId: 'c1',
          resultText: 'r1',
          withTurnEnd: true,
        }),
      ],
    });
    const before = session.surface.nodes.length;
    const ctx = makeCtx({
      llmStreamFactory: (index) => {
        if (index === 0) return roundChunks({ calls: [{ id: 'g1', name: 'getHistory' }] });
        if (index === 1)
          return roundChunks({
            calls: [
              {
                id: 't1',
                name: 'compressHistory',
                args: { index: 0, content: 'REFLECTED-REPORT' },
              },
            ],
          });
        return roundChunks({ calls: [{ id: 'c9', name: 'completeCompression' }] });
      },
    });
    apply(ctx, { reflectThresholdTokens: 1 });
    await runPreStep(ctx, session);
    expect(ctx._llmCalls).toHaveLength(3);
    expect(instructionText(ctx._llmCalls[0]?.options)).toBe(buildCompressionPrompt(true)); // 反思与观察共用同一套提示词
    // 压缩指令为反思表述（合并全部块），不含历史内容
    const taskText = inputText(ctx);
    expect(taskText).toContain('合并压缩');
    expect(taskText).not.toContain('X'.repeat(40));
    expect(session.surface.nodes.length).toBe(before); // 单块区段替换，节点数不变
    expect(latestHistoryText(session)).toContain('REFLECTED');
    expect(latestHistoryText(session)).not.toContain('X'.repeat(40)); // 旧摘要被替换
  });

  it('多块反思：按全部块总长触发，把整个块区段合并为一条', async () => {
    // 两个块（各含一条 assistant 条目，合计 ≥ 反思阈值 1）→ 触发反思
    const session = makeSession({
      events: [
        historyMessage(`<assistant index="0">${'X'.repeat(40)}</assistant>`, 'h1'),
        historyMessage(`<assistant index="4">${'Y'.repeat(40)}</assistant>`, 'h2'),
        ...buildToolCallFlow({
          code: 'a()',
          description: '任务A',
          callId: 'c1',
          resultText: 'r1',
          withTurnEnd: true,
        }),
      ],
    });
    const before = session.surface.nodes.length;
    const ctx = makeCtx({
      llmStreamFactory: (index) => {
        if (index === 0) return roundChunks({ calls: [{ id: 'g1', name: 'getHistory' }] });
        if (index === 1)
          return roundChunks({
            calls: [
              {
                id: 't1',
                name: 'compressHistory',
                args: { start: 0, end: 4, content: 'MERGED-REPORT' },
              },
            ],
          });
        return roundChunks({ calls: [{ id: 'c9', name: 'completeCompression' }] });
      },
    });
    apply(ctx, { reflectThresholdTokens: 1 });
    await runPreStep(ctx, session);
    expect(ctx._llmCalls).toHaveLength(3);
    expect(instructionText(ctx._llmCalls[0]?.options)).toBe(buildCompressionPrompt(true));
    expect(session.surface.nodes.length).toBe(before - 1); // 两块合并为一条
    expect(latestHistoryText(session)).toContain('MERGED');
    expect(latestHistoryText(session)).not.toContain('X'.repeat(40)); // 全部旧块被替换
    expect(latestHistoryText(session)).not.toContain('Y'.repeat(40));
    // 合并替换整个块区段（遮蔽两块）
    const { summary } = compactionLifecycle(session);
    const summaryEvent = session.events[summary];
    if (summaryEvent?.type !== 'compaction/summary') throw new Error('缺 summary');
    expect(summaryEvent.data.shadowedRange).toEqual({ start: 0, end: 1 });
    expect(summaryEvent.data.shadowedSeqs).toEqual([0, 1]);
    expect((summaryEvent.data as CompactionSummaryPayload).shadowedCharCount).toBeGreaterThan(0);
  });

  it('反思视图：getHistory 返回块内条目（含 user 原文），压缩替换 assistant 条目', async () => {
    // 块 1：user 原文条目 + assistant 摘要条目（带块首格式说明注释）；
    // 块 2：user 条目内含 tip 文本（正文原样保留）；条目内的 XML 注释在解析后不保留
    const session = makeSession({
      events: [
        historyMessage(
          `${HISTORY_FORMAT_NOTE}\n<user_message index="0">\nOLD-SUMMARY-1\n</user_message>\n<assistant index="1">\nA-摘要\n</assistant>`,
        ),
        historyMessage(
          `<user_message index="4">\ntip="正文内的 tip 文本"\n</user_message>\n<assistant index="5">\nB-摘要\n</assistant>`,
          'h2',
        ),
        ...buildToolCallFlow({
          code: 'a()',
          description: '任务A',
          callId: 'c1',
          resultText: 'r1',
          withTurnEnd: true,
        }),
      ],
    });
    let seenHistory = '';
    const ctx = makeCtx({
      llmStreamFactory: (index) => {
        if (index === 0) {
          // 第 1 轮 getHistory：捕获返回给模型的条目文本（在工具结果消息中体现于第 2 轮请求）
          return roundChunks({ calls: [{ id: 'g1', name: 'getHistory' }] });
        }
        if (index === 1) {
          const second = ctx._llmCalls[1];
          const messages = second
            ? (second.options as { messages?: unknown[] }).messages
            : undefined;
          seenHistory = JSON.stringify(messages);
          return roundChunks({
            calls: [
              {
                id: 't1',
                name: 'compressHistory',
                args: { start: 1, end: 5, content: '合并后的历史条目内容' },
              },
              // 覆盖 user 条目（index 4）报错后再分别压缩两个 assistant 条目
              {
                id: 't2',
                name: 'compressHistory',
                args: { index: 1, content: 'A 的重新压缩' },
              },
              {
                id: 't3',
                name: 'compressHistory',
                args: { index: 5, content: 'B 的重新压缩' },
              },
            ],
          });
        }
        return roundChunks({ calls: [{ id: 'c9', name: 'completeCompression' }] });
      },
    });
    apply(ctx, { reflectThresholdTokens: 1 });
    await runPreStep(ctx, session);
    expect(ctx._llmCalls).toHaveLength(3);
    // getHistory 结果（第 2 轮请求携带）：user 条目原样、assistant 条目为块内摘要；
    // 块首格式说明注释不进入视图
    expect(seenHistory).toContain('OLD-SUMMARY-1');
    expect(seenHistory).toContain('A-摘要');
    expect(seenHistory).not.toContain(HISTORY_FORMAT_NOTE); // 块首格式注释剥离
    expect(seenHistory).toContain('tip='); // 正文内的 tip 同形文本原样保留
    expect(seenHistory).toContain('正文内的 tip 文本');
    // 最终块：user 条目原样保留 + 各 assistant 条目的重新压缩
    const historyText = latestHistoryText(session);
    expect(historyText).toContain('<user_message index="0">');
    expect(historyText).toContain('OLD-SUMMARY-1');
    expect(historyText).toContain('A 的重新压缩');
    expect(historyText).toContain('B 的重新压缩');
    expect(historyText).not.toContain('A-摘要');
    expect(historyText).not.toContain('B-摘要');
    // 第 3 轮请求包含覆盖 user 条目的工具报错（模型可修正）
    const third = ctx._llmCalls[2];
    expect(JSON.stringify(third?.options)).toContain('用户消息不可压缩');
  });

  it('先反思后观察串行：反思合并旧块，观察在其后追加独立新块', async () => {
    // 反思阈值 90：旧块（X*400，约 112 tokens）首次触发反思；合并后的块不再触发；
    // 观察阈值 1（上下文压力 ✓）延迟一步后执行
    const session = makeSession({
      events: [
        historyMessage(`<assistant index="0">${'X'.repeat(400)}</assistant>`),
        ...buildToolCallFlow({
          code: 'a()',
          description: '任务A',
          callId: 'c1',
          resultText: 'r1',
          withTurnEnd: true,
        }),
      ],
    });
    // 逐轮脚本：第 1-3 轮为反思（getHistory → compress REFLECTED → complete），
    // 第 4-6 轮为观察（getHistory → compress OBSERVED → complete）
    const ctx = makeCtx({
      llmStreamFactory: (index) => {
        if (index === 0 || index === 3)
          return roundChunks({ calls: [{ id: 'g1', name: 'getHistory' }] });
        if (index === 1)
          return roundChunks({
            calls: [
              {
                id: 't1',
                name: 'compressHistory',
                args: { index: 0, content: 'REFLECTED-REPORT' },
              },
            ],
          });
        if (index === 4)
          return roundChunks({
            calls: [
              {
                id: 't2',
                name: 'compressHistory',
                args: { start: 1, end: 2, content: 'OBSERVED-PASS' },
              },
            ],
          });
        return roundChunks({ calls: [{ id: 'c9', name: 'completeCompression' }] });
      },
    });
    apply(ctx, { tailMessageCount: 1, observeThresholdTokens: 1, reflectThresholdTokens: 90 });
    await runPreStepWithDelay(ctx, session);
    expect(ctx._llmCalls).toHaveLength(6);
    const firstText = instructionText(ctx._llmCalls[0]?.options);
    const secondText = instructionText(ctx._llmCalls[3]?.options);
    // 两者共用同一套提示词；以压缩指令（数据源）区分反思/观察
    expect(firstText).toBe(buildCompressionPrompt(true));
    expect(secondText).toBe(buildCompressionPrompt(true));
    const inputOf = (call: unknown) =>
      String(
        (call as { messages?: Array<{ content?: Array<{ type?: string; text?: string }> }> })
          ?.messages?.[0]?.content?.[0]?.text ?? '',
      );
    expect(inputOf(ctx._llmCalls[0]?.options)).toContain('合并压缩'); // 反思指令
    expect(inputOf(ctx._llmCalls[3]?.options)).toContain('压缩完整消息区间'); // 观察指令
    // 反思把旧块合并为 REFLECTED 块；观察在旧块之后追加独立 OBSERVED 块（两块并存）
    const historyMsgs = session.surface.nodes
      .map((seq) => session.events[seq])
      .filter(
        (e): e is SessionEvent =>
          e?.type === 'user/message' &&
          String(
            ((e.data as { source?: unknown }).source as { kind?: string } | undefined)?.kind,
          ) === 'plugin',
      );
    expect(historyMsgs).toHaveLength(2);
    const texts = historyMsgs.map((e) =>
      String(
        ((e.data as { content?: unknown[] }).content?.[0] as { text?: string } | undefined)?.text ??
          '',
      ),
    );
    expect(texts[0]).toContain('REFLECTED');
    expect(texts[0]).not.toContain('OBSERVED');
    expect(texts[1]).toContain('OBSERVED');
    expect(texts[1]).not.toContain('REFLECTED');
  });
});

describe('apply 接线（compaction 生命周期与 checkpoint 标记）', () => {
  async function runPreStep(ctx: ReturnType<typeof makeCtx>, session: Session) {
    const preStepListeners = ctx._onCallbacks.get('agent/pre-step');
    let nextCalled = false;
    const next = () => {
      nextCalled = true;
    };
    await preStepListeners?.[0]?.(
      { agent: { session }, signal: new AbortController().signal },
      next,
    );
    return nextCalled;
  }

  it('反思压缩：单节点替换也写完整 compaction 生命周期（summary/遮蔽/provider/model）', async () => {
    // 单块含一条 assistant 条目（约 15 tokens）；反思阈值 1 → 触发反思；观察阈值保持默认不触发
    const session = makeSession({
      events: [
        historyMessage(`<assistant index="0">${'X'.repeat(40)}</assistant>`),
        ...buildToolCallFlow({
          code: 'a()',
          description: '任务A',
          callId: 'c1',
          resultText: 'r1',
          withTurnEnd: true,
        }),
      ],
    });
    const ctx = makeCtx({
      llmStreamFactory: (index) => {
        if (index === 0) return roundChunks({ calls: [{ id: 'g1', name: 'getHistory' }] });
        if (index === 1)
          return roundChunks({
            calls: [
              {
                id: 't1',
                name: 'compressHistory',
                args: { index: 0, content: 'REFLECTED-REPORT' },
              },
            ],
          });
        return roundChunks({ calls: [{ id: 'c9', name: 'completeCompression' }] });
      },
    });
    apply(ctx, { reflectThresholdTokens: 1 });
    await runPreStep(ctx, session);
    const { start, summary, end, replace } = compactionLifecycle(session);
    expect(start).not.toBe(-1);
    expect(summary).toBe(start + 1);
    expect(replace).toBe(summary + 1);
    expect(end).toBe(replace + 1);
    const startEvent = session.events[start];
    const summaryEvent = session.events[summary];
    const endEvent = session.events[end];
    const replaceEvent = session.events[replace];
    if (startEvent?.type !== 'compaction/start') throw new Error('缺 start');
    if (summaryEvent?.type !== 'compaction/summary') throw new Error('缺 summary');
    if (endEvent?.type !== 'compaction/end') throw new Error('缺 end');
    expect(summaryEvent.data.compactionId).toBe(startEvent.data.compactionId);
    expect(endEvent.data.compactionId).toBe(startEvent.data.compactionId);
    // 反思压缩：start 携带 phase='reflect'（UI 压缩中提示按阶段区分）；3 轮请求 → attemptCount=3
    expect((startEvent.data as { phase?: string }).phase).toBe('reflect');
    expect((summaryEvent.data as CompactionSummaryPayload).attemptCount).toBe(3);
    // 单节点替换：遮蔽区间为旧 <history> 节点
    expect(summaryEvent.data.shadowedRange).toEqual({ start: 0, end: 0 });
    expect(summaryEvent.data.shadowedSeqs).toEqual([0]);
    expect((summaryEvent.data as CompactionSummaryPayload).shadowedCharCount).toBeGreaterThan(0);
    expect(summaryEvent.data.provider).toBe('test');
    expect(summaryEvent.data.model).toBe('test-model');
    expect(summaryEvent.data.maxTokens).toBeUndefined(); // compressMaxTokens 默认不设置
    // summary 内容 = 合并后摘要
    const summaryText = summaryEvent.data.summary
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    expect(summaryText).toContain('REFLECTED');
    // 替换消息 source = 插件标识
    const source = checkpointSourceOf(replaceEvent);
    expect(source?.plugin).toBe(PLUGIN_LABEL);
    expect(source?.compactionId).toBe(startEvent.data.compactionId);
  });

  it('观察增量追加：compaction/summary 内容 = 新观察日志；遮蔽仅新消息区间', async () => {
    const flowEvents = buildToolCallFlow({
      code: 'a()',
      description: '任务A',
      callId: 'c1',
      resultText: 'r1',
      withTurnEnd: true,
    });
    const session = makeSession({
      events: [historyMessage('user_message message_id:old-u text:旧任务'), ...flowEvents],
    });
    const ctx = makeCtx({
      llmStreamFactory: (index) => {
        if (index === 0) return roundChunks({ calls: [{ id: 'g1', name: 'getHistory' }] });
        if (index === 1)
          return roundChunks({
            calls: [
              {
                id: 't1',
                name: 'compressHistory',
                args: { start: 1, end: 2, content: 'toolcall index:2 purpose:任务A summary:完成' },
              },
            ],
          });
        return roundChunks({ calls: [{ id: 'c9', name: 'completeCompression' }] });
      },
    });
    // 反思阈值 1000 > 旧摘要——隔离观察路径
    apply(ctx, { tailMessageCount: 1, observeThresholdTokens: 1, reflectThresholdTokens: 1000 });
    await runPreStepWithDelay(ctx, session);
    const { start, summary } = compactionLifecycle(session);
    expect(start).not.toBe(-1);
    const summaryEvent = session.events[summary];
    if (summaryEvent?.type !== 'compaction/summary') throw new Error('缺 summary');
    const summaryText = summaryEvent.data.summary
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    expect(summaryText).toContain('请帮我完成一个任务'); // summary = 本次观察日志（未压缩 user 原样保留）
    expect(summaryText).not.toContain('旧任务'); // 不再合并旧摘要原文
    // 遮蔽数据 = 压缩边界至触发点区间（旧块 seq 0 保留、不计入遮蔽）
    expect(summaryEvent.data.shadowedRange).toEqual({ start: 1, end: 4 });
    expect(summaryEvent.data.shadowedSeqs).toEqual([1, 2, 4]);
    expect((summaryEvent.data as CompactionSummaryPayload).shadowedCharCount).toBe(17); // user 9 + assistant 6 + result 2
  });
});

describe('OM 压缩 token 归入主会话（compaction/summary.usage）', () => {
  /** 延迟压缩两步执行：触发（记录待定标记）→ 追加等待期消息 → 执行压缩。 */
  async function runPreStep(ctx: ReturnType<typeof makeCtx>, session: Session) {
    const preStepListeners = ctx._onCallbacks.get('agent/pre-step');
    const run = () =>
      preStepListeners?.[0]?.(
        { agent: { session }, signal: new AbortController().signal },
        () => {},
      );
    await run();
    session.append(
      'user/message',
      makeMessage({
        content: [textBlock('延迟等待期的新消息')],
        id: `wait-${session.events.length}`,
      }) as unknown as UserMessage,
      { surfaceOp: 'append' },
    );
    await run();
  }

  /** 成功压缩循环的轮脚本（第 2 轮可注入 usage）。 */
  function successRounds(usage?: { inputTokens: number; outputTokens: number }) {
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
          ...(usage === undefined ? {} : { usage }),
        });
      return roundChunks({ calls: [{ id: 'c9', name: 'completeCompression' }] });
    };
  }

  /** 触发观察压缩的固定夹具（观察阈值 1 tokens 必触发）。 */
  function sessionAndCtx(extra: Parameters<typeof makeCtx>[0] = {}) {
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
      llmStreamFactory: successRounds(),
      ...extra,
    });
    apply(ctx, { tailMessageCount: 1, observeThresholdTokens: 1 });
    return { session, ctx };
  }

  it('压缩循环报告 usage：各轮汇总后写入主会话 compaction/summary.usage', async () => {
    const { session, ctx } = sessionAndCtx({
      llmStreamFactory: successRounds({ inputTokens: 100, outputTokens: 50 }),
    });
    await runPreStep(ctx, session);
    const summaryIdx = session.events.findIndex((e) => e.type === 'compaction/summary');
    const summaryEvent = session.events[summaryIdx];
    if (summaryEvent?.type !== 'compaction/summary') throw new Error('缺 summary');
    expect(summaryEvent.data.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
  });

  it('压缩循环无 usage（无 usage chunk）时省略 usage 字段', async () => {
    const { session, ctx } = sessionAndCtx(); // 默认 mock：无 usage chunk
    await runPreStep(ctx, session);
    const summaryIdx = session.events.findIndex((e) => e.type === 'compaction/summary');
    const summaryEvent = session.events[summaryIdx];
    if (summaryEvent?.type !== 'compaction/summary') throw new Error('缺 summary');
    expect(summaryEvent.data.usage).toBeUndefined();
  });
});

describe('压缩请求形态（新会话直连）', () => {
  /** 延迟压缩两步执行：触发（记录待定标记）→ 追加等待期消息 → 执行压缩。 */
  async function runPreStep(ctx: ReturnType<typeof makeCtx>, session: Session) {
    const preStepListeners = ctx._onCallbacks.get('agent/pre-step');
    const run = () =>
      preStepListeners?.[0]?.(
        { agent: { session }, signal: new AbortController().signal },
        () => {},
      );
    await run();
    session.append(
      'user/message',
      makeMessage({
        content: [textBlock('延迟等待期的新消息')],
        id: `wait-${session.events.length}`,
      }) as unknown as UserMessage,
      { surfaceOp: 'append' },
    );
    await run();
  }

  /** 带 requestHeader system/tools 的会话（断言压缩请求不复用主会话请求前缀）。 */
  function sessionWithHeader() {
    return makeSession({
      events: buildToolCallFlow({
        code: 'a()',
        description: '任务A',
        callId: 'c1',
        resultText: 'r1',
        withTurnEnd: true,
      }),
      requestHeaderValue: {
        config: { provider: 'test', model: 'test-model' },
        system: '主会话系统提示词',
        tools: [{ name: 'run_code' }],
      },
    });
  }

  it('压缩会话独立组装：指令作为 system，首条消息 = 压缩指令 + 区间，工具 = 三个压缩工具', async () => {
    const session = sessionWithHeader();
    const ctx = makeCtx({
      // 会话请求头带 tools（JSON 21 字符 → 6 tokens）：注入真实 usage 锚定压力，扣除工具定义后仍达阈值
      meterTotalTokens: 100000,
      llmStreamFactory: (index) => {
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
      },
    });
    apply(ctx, { tailMessageCount: 1, observeThresholdTokens: 1 });
    await runPreStep(ctx, session);
    const options = ctx._llmCalls[0]?.options as {
      system?: string;
      tools?: Array<{ name: string }>;
      messages?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
    };
    // 不复用主会话 requestHeader（system 前缀不沿用）；system = 共享压缩提示词
    expect(options?.system).toBe(buildCompressionPrompt(true));
    expect(options?.system).not.toContain('主会话系统提示词');
    // 工具 = 三个压缩工具（不沿用主会话工具）
    expect(options?.tools?.map((t) => t.name)).toEqual([
      'getHistory',
      'compressHistory',
      'completeCompression',
    ]);
    const input = String(options?.messages?.[0]?.content?.[0]?.text ?? '');
    // 首条消息 = 压缩指令 + 完整消息区间，不含历史消息内容
    expect(input).toContain('压缩完整消息区间');
    expect(input).toContain('getHistory');
    expect(input).toContain('completeCompression');
    expect(input).not.toContain('请帮我完成一个任务'); // 历史内容不进指令
    expect(input).not.toContain('message_id=user-c1'); // 不用 message_id
    expect(session.surface.nodes.length).toBe(2); // 等待期新消息 + <history>
  });
});

// apply 接线（工具注册开关）：recallEnabled / semanticRecallEnabled 配置键
// 独立控制 recall / recall-semantic 工具注册，缺省启用；false 禁用；不影响压缩接线。
describe('apply 接线（recallEnabled / semanticRecallEnabled）', () => {
  /** 已注册工具名集合。 */
  function registeredNames(ctx: ReturnType<typeof makeCtx>): string[] {
    return ctx._registeredTools.map((t) => t.name).filter((n): n is string => n !== undefined);
  }

  it('缺省两个工具都注册', () => {
    const ctx = makeCtx();
    apply(ctx, {});
    expect(registeredNames(ctx)).toEqual(expect.arrayContaining(['recall', 'recall-semantic']));
  });

  it('recallEnabled=false 仅禁用 recall，recall-semantic 仍注册', () => {
    const ctx = makeCtx();
    apply(ctx, { recallEnabled: false });
    const names = registeredNames(ctx);
    expect(names).not.toContain('recall');
    expect(names).toContain('recall-semantic');
  });

  it('semanticRecallEnabled=false 仅禁用 recall-semantic，recall 仍注册', () => {
    const ctx = makeCtx();
    apply(ctx, { semanticRecallEnabled: false });
    const names = registeredNames(ctx);
    expect(names).toContain('recall');
    expect(names).not.toContain('recall-semantic');
  });

  it('两个开关都=false 时两个工具都不注册，压缩接线不受影响', () => {
    const ctx = makeCtx();
    apply(ctx, { recallEnabled: false, semanticRecallEnabled: false });
    const names = registeredNames(ctx);
    expect(names).not.toContain('recall');
    expect(names).not.toContain('recall-semantic');
    // 工具注册开关只控制 recall 工具，agent/pre-step 压缩监听始终注册
    expect(ctx._onCallbacks.has('agent/pre-step')).toBe(true);
  });

  it('启用：apply 触发模型后台预热下载（ensureModelReady 被调用）', () => {
    const mockEnsure = ensureModelReady as unknown as ReturnType<typeof vi.fn>;
    mockEnsure.mockClear();
    const ctx = makeCtx();
    apply(ctx, {});
    expect(mockEnsure).toHaveBeenCalled();
  });

  it('semanticRecallEnabled=false：不触发模型下载', () => {
    const mockEnsure = ensureModelReady as unknown as ReturnType<typeof vi.fn>;
    mockEnsure.mockClear();
    const ctx = makeCtx();
    apply(ctx, { semanticRecallEnabled: false });
    expect(mockEnsure).not.toHaveBeenCalled();
  });
});

// apply 接线（延迟观察压缩：触发 → 待定 → 延迟执行）：净压力首次达阈值时记录
// om/observe-pending 待定标记（触发点 = 最后一条完整消息 index）本次不压缩；待定后
// 新增完整消息数 ≥ tailMessageCount 时执行压缩（区间截至触发点）并写 om/observe-invalidate
// 失效标记；摘要失败保留待定直接重试；标记以 om 信封事件（借用 feedback/record）
// 持久化在会话日志中，重启后从日志恢复。
describe('apply 接线（延迟观察压缩：触发 → 待定 → 延迟执行）', () => {
  /** 运行一次 pre-step 监听器，返回 next 是否被调用。 */
  async function runPreStep(ctx: ReturnType<typeof makeCtx>, session: Session) {
    const listeners = ctx._onCallbacks.get('agent/pre-step');
    let nextCalled = false;
    await listeners?.[0]?.({ agent: { session }, signal: new AbortController().signal }, () => {
      nextCalled = true;
    });
    return nextCalled;
  }

  /** 追加一条等待期用户消息（完整消息 index +1）。 */
  function appendWaitingMessage(session: Session, id: string): void {
    session.append(
      'user/message',
      makeMessage({ content: [textBlock('延迟等待期的新消息')], id }) as unknown as UserMessage,
      { surfaceOp: 'append' },
    );
  }

  /** 单条 runcode 流程 + turn/end：完整消息 0..2（触发点 = 2）。 */
  function singleFlowSession(extra: SessionEvent[] = []) {
    return makeSession({
      events: [
        ...buildToolCallFlow({
          code: 'a()',
          description: '任务A',
          callId: 'c1',
          resultText: 'r1',
          withTurnEnd: true,
        }),
        ...extra,
      ],
    });
  }

  /** 返回成功完成压缩的 ctx（观察阈值需在 apply 配置中触发）。 */
  function observeCtx() {
    return makeCtx({
      llmStreamFactory: (index) => {
        if (index === 0) return roundChunks({ calls: [{ id: 'g1', name: 'getHistory' }] });
        if (index === 1)
          return roundChunks({
            calls: [
              {
                id: 't2',
                name: 'compressHistory',
                args: { start: 1, end: 2, content: 'toolcall index:2 purpose:任务A summary:完成' },
              },
            ],
          });
        return roundChunks({ calls: [{ id: 'c9', name: 'completeCompression' }] });
      },
    });
  }

  it('触发即待定：达阈值记录 om/observe-pending（触发点 = 最后完整消息 index），本次不压缩', async () => {
    const session = singleFlowSession();
    const ctx = observeCtx();
    apply(ctx, { tailMessageCount: 1, observeThresholdTokens: 1 });
    const nextCalled = await runPreStep(ctx, session);
    expect(nextCalled).toBe(true); // 触发不中断，正常放行
    expect(ctx._llmCalls).toHaveLength(0); // 延迟执行：本次无压缩请求
    const pendingEvents = findOmEvents(session, 'om/observe-pending');
    expect(pendingEvents).toHaveLength(1);
    expect(pendingEvents[0]?.data).toEqual({ triggerMessageIndex: 2 });
    expect(session.events.some((e) => isOmKind(e, 'om/observe-invalidate'))).toBe(false);
    expect(session.surface.nodes.length).toBe(3); // 表层不变
  });

  it('活跃待定期间不重复添加：连续 pre-step 仅一条 pending', async () => {
    const session = singleFlowSession();
    const ctx = observeCtx();
    apply(ctx, { tailMessageCount: 3, observeThresholdTokens: 1 });
    await runPreStep(ctx, session);
    await runPreStep(ctx, session); // 未满 K，等待中
    expect(findOmEvents(session, 'om/observe-pending')).toHaveLength(1);
    expect(ctx._llmCalls).toHaveLength(0);
  });

  it('未满 K 等待：新增完整消息数不足时不执行', async () => {
    const session = singleFlowSession();
    const ctx = observeCtx();
    apply(ctx, { tailMessageCount: 2, observeThresholdTokens: 1 });
    await runPreStep(ctx, session); // 触发
    appendWaitingMessage(session, 'wait-1'); // 新增 1 < 2
    await runPreStep(ctx, session);
    expect(ctx._llmCalls).toHaveLength(0);
    const steps = ctx._loggerCalls.filter((c) => c.level === 'debug').map((c) => String(c.args[0]));
    expect(
      steps.some((s) => s.includes('待定标记等待中（触发点完整消息 index 2，新增 1/2 条）')),
    ).toBe(true);
  });

  it('满 K 执行：压缩区间截至触发点，等待期消息不被压缩，执行后写失效标记', async () => {
    const session = singleFlowSession();
    const ctx = observeCtx();
    apply(ctx, { tailMessageCount: 1, observeThresholdTokens: 1 });
    await runPreStep(ctx, session); // 触发：triggerMessageIndex = 2
    appendWaitingMessage(session, 'wait-exec'); // 新增 1 ≥ 1
    await runPreStep(ctx, session);
    expect(ctx._llmCalls).toHaveLength(3); // getHistory → compressHistory → completeCompression
    // 压缩区间 [0..3]（触发点完整消息 index 2 = toolcall，最后事件 seq 3 平衡）
    const { summary } = compactionLifecycle(session);
    const summaryEvent = session.events[summary];
    if (summaryEvent?.type !== 'compaction/summary') throw new Error('缺 summary');
    expect(summaryEvent.data.shadowedSeqs).toEqual([0, 1, 3]);
    // 等待期消息保留在表层（未被压缩）
    const waitingSeq = session.events.findIndex(
      (e) => e.type === 'user/message' && (e.data as { id?: string }).id === 'wait-exec',
    );
    expect(waitingSeq).toBeGreaterThanOrEqual(0);
    expect(session.surface.nodes).toContain(waitingSeq);
    expect(latestHistoryText(session)).toContain('请帮我完成一个任务');
    // 执行成功后写失效标记，指向待定标记事件 seq
    const pendings = findOmEvents(session, 'om/observe-pending');
    const invalidates = findOmEvents(session, 'om/observe-invalidate');
    expect(pendings).toHaveLength(1);
    expect(invalidates).toHaveLength(1);
    expect(invalidates[0]?.data.pendingSeq).toBe(pendings[0]?.seq);
  });

  it('K=0：触发当轮立即执行（无待定/失效标记）', async () => {
    const session = singleFlowSession();
    const ctx = observeCtx();
    apply(ctx, { tailMessageCount: 0, observeThresholdTokens: 1 });
    await runPreStep(ctx, session);
    expect(ctx._llmCalls).toHaveLength(3);
    expect(session.events.some((e) => isOmKind(e, 'om/observe-pending'))).toBe(false);
    expect(session.events.some((e) => isOmKind(e, 'om/observe-invalidate'))).toBe(false);
    expect(latestHistoryText(session)).toContain('请帮我完成一个任务');
  });

  it('压缩失败保留待定：下个 pre-step 到期直接重试执行并成功', async () => {
    const session = singleFlowSession();
    let failed = true;
    const ctx = makeCtx({
      llmStreamFactory: (index) => {
        if (failed) return roundChunks({ text: '不调用工具' }); // 连续 2 轮纯文本 → 失败
        // 重试执行走完整三轮（getHistory → compressHistory → completeCompression）
        if (index === 2) return roundChunks({ calls: [{ id: 'g1', name: 'getHistory' }] });
        if (index === 3)
          return roundChunks({
            calls: [
              {
                id: 't2',
                name: 'compressHistory',
                args: { start: 1, end: 2, content: 'toolcall index:2 purpose:任务A summary:完成' },
              },
            ],
          });
        return roundChunks({ calls: [{ id: 'c9', name: 'completeCompression' }] });
      },
    });
    apply(ctx, { tailMessageCount: 1, observeThresholdTokens: 1 });
    await runPreStep(ctx, session); // 触发
    appendWaitingMessage(session, 'wait-fail');
    await runPreStep(ctx, session); // 执行：2 轮纯文本判失败
    expect(ctx._llmCalls).toHaveLength(2);
    expect(session.events.some((e) => isOmKind(e, 'om/observe-invalidate'))).toBe(false);
    appendWaitingMessage(session, 'wait-retry');
    failed = false;
    await runPreStep(ctx, session); // 待定仍在、到期条件仍满足 → 直接重试执行
    expect(ctx._llmCalls).toHaveLength(5); // 失败 2 轮 + 重试成功 3 轮
    expect(session.events.some((e) => isOmKind(e, 'om/observe-invalidate'))).toBe(true);
    expect(latestHistoryText(session)).toContain('请帮我完成一个任务');
  });

  it('重启恢复：待定标记从会话日志恢复（新会话对象含 pending 事件即可续跑）', async () => {
    // 模拟重启：pending 事件已持久化在日志中，重建的会话对象直接带上它
    const session = singleFlowSession([pendingEvent(2)]);
    const ctx = observeCtx();
    apply(ctx, { tailMessageCount: 1, observeThresholdTokens: 1 });
    await runPreStep(ctx, session); // 未满 K：等待（新增 0 < 1）
    expect(ctx._llmCalls).toHaveLength(0);
    appendWaitingMessage(session, 'wait-resume'); // 新增 1 ≥ 1
    await runPreStep(ctx, session);
    expect(ctx._llmCalls).toHaveLength(3);
    expect(latestHistoryText(session)).toContain('请帮我完成一个任务');
    const invalidateEvent = session.events.findLast((e) => isOmKind(e, 'om/observe-invalidate'));
    expect(invalidateEvent).toBeDefined();
  });

  it('过期待定不阻塞再触发：边界后移即过期，重新触发新一轮标记（不误压已压缩内容）', async () => {
    // 模拟「执行成功但失效标记未写出」的崩溃窗口：pending 之后提交了新 <history> 块
    // （压缩边界 6 > pending 5）→ 旧 pending 过期；表层仅剩新块（flow 内容已被遮蔽）
    const session = makeSession({
      events: [
        ...buildToolCallFlow({
          code: 'a()',
          description: '任务A',
          callId: 'c1',
          resultText: 'r1',
          withTurnEnd: true,
        }),
        pendingEvent(2), // seq 5
        historyMessage('压缩后的块', 'history-after'), // seq 6：边界后移 → 旧 pending 过期
      ],
      surfaceNodes: [6], // flow 表层节点已被 seq 6 的替换块遮蔽
    });
    // 表层仅剩压缩后的历史块：注入真实 usage 锚定压力，扣除已压缩块后仍达阈值
    const ctx = makeCtx({
      meterTotalTokens: 100000,
      llmStreamFactory: (index) => {
        if (index === 0) return roundChunks({ calls: [{ id: 'g1', name: 'getHistory' }] });
        return roundChunks({ calls: [{ id: 'c9', name: 'completeCompression' }] });
      },
    });
    apply(ctx, { tailMessageCount: 1, observeThresholdTokens: 1 });
    await runPreStep(ctx, session); // 过期 → 重新触发：新一轮 pending（seq 7，触发点仍为 index 2）
    expect(ctx._llmCalls).toHaveLength(0);
    expect(findOmEvents(session, 'om/observe-pending')).toHaveLength(2);
    appendWaitingMessage(session, 'wait-expired'); // 新增 1 ≥ 1
    await runPreStep(ctx, session); // 触发点内容已被压缩 → 无可行区间 → 清除标记视为完成
    expect(ctx._llmCalls).toHaveLength(0); // 不对已压缩内容发起压缩
    expect(session.events.some((e) => isOmKind(e, 'om/observe-invalidate'))).toBe(true); // 新标记已失效
    expect(latestHistoryText(session)).toContain('压缩后的块'); // 无新增替换
  });
});
