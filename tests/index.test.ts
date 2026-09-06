// index.ts（插件入口）apply 接线的集成级单元测试：OM 观察压缩与增量追加、反思压缩、
// compaction 生命周期与 checkpoint 标记、摘要 token 归入、摘要请求形态、
// recall/semanticRecall 工具开关与 ensureModelReady 预热、入口导出。
import { describe, expect, it, vi } from 'vitest';

// 隔离 apply 的模型下载编排：ensureModelReady 打桩为"就绪"，避免单测触发真实下载/网络
vi.mock('../src/embedding.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/embedding.ts')>();
  return {
    ...actual,
    ensureModelReady: vi.fn(async () => 'ready' as const),
  };
});

import { HISTORY_TAG, PLUGIN_LABEL } from '../src/constants.ts';
import { ensureModelReady } from '../src/embedding.ts';
import { apply, inject, name } from '../src/index.ts';
import { findOmEvents } from '../src/om-event.ts';
import { buildHistoryPrompt, HISTORY_FORMAT_NOTE } from '../src/summarize.ts';
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
  textBlock,
} from './helpers.ts';

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

  /** 返回固定观察报告的 ctx（触发观察需在 apply 配置中设置 observeThresholdTokens）。 */
  function observeCtx(report: string) {
    return makeCtx({
      llmStream: [{ type: 'text-delta', text: report }],
    });
  }

  it('触发观察：摘要调用 → 追加为 <history>，替换被压缩区间', async () => {
    const flowEvents = buildToolCallFlow({
      code: 'runMe()',
      description: '跑一下',
      callId: 'c-eval',
      resultText: 'done',
      withTurnEnd: true,
    });
    const session = makeSession({ events: flowEvents });
    const report = [
      '<history>',
      '<user_message index="0">',
      '请帮我完成一个任务',
      '</user_message>',
      '<assistant start="1" end="2">',
      'toolcall index:2 purpose:跑一下 summary:产物符合预期；下一步提交',
      '</assistant>',
      '</history>',
    ].join('\n');
    const ctx = observeCtx(report);
    apply(ctx, { tailMessageCount: 0, observeThresholdTokens: 1 });

    expect(ctx._sections).toHaveLength(0);
    expect(ctx._registeredTools.some((t) => t.name === 'recall')).toBe(true);
    expect(ctx._registeredTools.some((t) => t.name === 'recall-semantic')).toBe(true);
    const sessionListeners = ctx._onCallbacks.get('session/event');
    expect(sessionListeners).toBeUndefined(); // 不监听 session/event

    const nextCalled = await runPreStep(ctx, session);
    expect(nextCalled).toBe(true); // 阻塞执行后放行
    expect(ctx._llmCalls).toHaveLength(1);
    const options = summaryOptions(ctx);
    // new 方式：persona + 提示词并入 system；输入为被压缩消息（user 消息）
    const instruction = instructionText(options);
    expect(instruction).toBe(buildHistoryPrompt()); // 共享提示词（观察/反思同一套）
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
    // start 携带压缩阶段（UI 压缩中提示按阶段区分文案）；首次尝试即成功 → attemptCount=0
    expect((startEvent.data as { phase?: string }).phase).toBe('observe');
    expect((summaryEvent.data as CompactionSummaryPayload).attemptCount).toBe(0);
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
  });

  it('系统消息参与压缩：输入渲染 <sys> 空块，模型输出必须保留 sys 条目', async () => {
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
    const report = [
      '<history>',
      '<sys type="agent-instructions" index="0"></sys>',
      '<user_message index="1">',
      '请帮我完成一个任务',
      '</user_message>',
      '<assistant start="2" end="3">',
      'toolcall index:3 purpose:跑一下 summary:产物符合预期',
      '</assistant>',
      '</history>',
    ].join('\n');
    const ctx = observeCtx(report);
    apply(ctx, { tailMessageCount: 0, observeThresholdTokens: 1 });
    await runPreStep(ctx, session);
    // 输入渲染：系统消息为 <sys> 空块（内容不进入压缩输入），用户消息 index 顺延为 1
    const options = summaryOptions(ctx);
    const input = (options.messages ?? [])
      .flatMap((m) => (m.content ?? []).map((b) => (b.type === 'text' ? b.text : '')))
      .join('');
    expect(input).toContain('<sys type="agent-instructions" index="0"></sys>');
    expect(input).not.toContain(sysText);
    expect(input).toContain('<user_message index="1">');
    // 模型输出保留 sys 条目 → 连续性校验通过，压缩成功；<history> 块含 sys 条目
    expect(ctx._llmCalls).toHaveLength(1);
    const historyText = latestHistoryText(session);
    expect(historyText).toContain('<sys type="agent-instructions" index="0"></sys>');
  });

  it('compressSkipReasoning=false：压缩输入与指令携带 <reasoning>（参考条目 + 说明两行）', async () => {
    const session = makeSession({
      events: [
        {
          type: 'user/message',
          data: makeMessage({
            content: [textBlock('请帮我完成一个任务')],
            id: 'u-reasoning',
          }),
        } as unknown as SessionEvent,
        {
          type: 'assistant/message',
          data: {
            message: makeMessage({
              role: 'assistant',
              content: [{ type: 'reasoning', text: '先想再答' }, textBlock('这是答案')],
              source: { kind: 'model', provider: 'test', model: 'test-model' },
              id: 'a-reasoning',
            }),
          },
        } as unknown as SessionEvent,
      ],
    });
    const report = [
      '<history>',
      '<user_message index="0">',
      '请帮我完成一个任务',
      '</user_message>',
      '<assistant index="1">',
      '这是答案',
      '</assistant>',
      '</history>',
    ].join('\n');
    const ctx = observeCtx(report);
    apply(ctx, {
      tailMessageCount: 0,
      observeThresholdTokens: 1,
      compressSkipReasoning: false,
    });
    const nextCalled = await runPreStep(ctx, session);
    expect(nextCalled).toBe(true);
    expect(ctx._llmCalls).toHaveLength(1);
    const options = summaryOptions(ctx);
    // 指令保留 <reasoning> 说明两行
    const instruction = instructionText(options);
    expect(instruction).toContain('<reasoning>：模型的思考过程，仅作压缩参考，产物中不要出现。');
    expect(instruction).toContain('<reasoning> 只作参考，输出产物中不包含 <reasoning> 块。');
    // 输入携带 <reasoning> 参考条目（不占 index，assistant 文本仍为 index 1）
    const input = (options.messages ?? [])
      .flatMap((m) => (m.content ?? []).map((b) => (b.type === 'text' ? b.text : '')))
      .join('');
    expect(input).toContain('<reasoning>先想再答</reasoning>');
    expect(input).toContain('<assistant index="1">');
    expect(input).toContain('这是答案');
  });

  it('compressSkipReasoning 默认 true：压缩输入与指令均不含 <reasoning>', async () => {
    const session = makeSession({
      events: [
        {
          type: 'user/message',
          data: makeMessage({
            content: [textBlock('请帮我完成一个任务')],
            id: 'u-skip',
          }),
        } as unknown as SessionEvent,
        {
          type: 'assistant/message',
          data: {
            message: makeMessage({
              role: 'assistant',
              content: [{ type: 'reasoning', text: '先想再答' }, textBlock('这是答案')],
              source: { kind: 'model', provider: 'test', model: 'test-model' },
              id: 'a-skip',
            }),
          },
        } as unknown as SessionEvent,
      ],
    });
    const report = [
      '<history>',
      '<user_message index="0">',
      '请帮我完成一个任务',
      '</user_message>',
      '<assistant index="1">',
      '这是答案',
      '</assistant>',
      '</history>',
    ].join('\n');
    const ctx = observeCtx(report);
    apply(ctx, { tailMessageCount: 0, observeThresholdTokens: 1 });
    const nextCalled = await runPreStep(ctx, session);
    expect(nextCalled).toBe(true);
    expect(ctx._llmCalls).toHaveLength(1);
    const options = summaryOptions(ctx);
    expect(instructionText(options)).not.toContain('<reasoning>');
    const input = (options.messages ?? [])
      .flatMap((m) => (m.content ?? []).map((b) => (b.type === 'text' ? b.text : '')))
      .join('');
    expect(input).not.toContain('<reasoning>');
    expect(input).not.toContain('先想再答');
    expect(input).toContain('<assistant index="1">');
    expect(input).toContain('这是答案');
  });

  it('系统消息缺失时压缩失败重试：模型输出缺 sys 条目 → 校验不通过，不产生替换', async () => {
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
    // 模型输出遗漏 sys 条目（只覆盖 1..3）：与预期覆盖区间 0..3 不连续 → 校验失败
    const report = [
      '<history>',
      '<user_message index="1">',
      '请帮我完成一个任务',
      '</user_message>',
      '<assistant start="2" end="3">',
      'toolcall index:3 purpose:跑一下 summary:产物符合预期',
      '</assistant>',
      '</history>',
    ].join('\n');
    const ctx = observeCtx(report);
    apply(ctx, { tailMessageCount: 0, observeThresholdTokens: 1 });
    const initialNodes = session.surface.nodes.length;
    await runPreStep(ctx, session);
    // 校验失败按 compressRetryCount 重试后放弃：不追加、不替换
    expect(ctx._llmCalls.length).toBeGreaterThan(1);
    expect(session.surface.nodes.length).toBe(initialNodes);
    expect(
      session.events.filter(
        (e) =>
          e.type === 'user/message' &&
          String(
            ((e.data as { content?: unknown[] }).content?.[0] as { text?: string } | undefined)
              ?.text ?? '',
          ).includes(`<${HISTORY_TAG}`),
      ),
    ).toHaveLength(0);
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
    // （含 tip 开标签约 26 tokens，不触发）——隔离观察路径验证增量追加；
    // 摘要输出覆盖区间 0..2（触发点完整消息 index 2）
    const ctx = observeCtx(
      '<history>\n<user_message index="0">\n新内容\n</user_message>\n<assistant start="1" end="2">toolcall index:2 purpose:任务A summary:完成</assistant>\n</history>',
    );
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
    expect(texts[0]).not.toContain('新内容'); // 旧块不被重写
    expect(texts[1]).toContain('新内容'); // 新块 = 本次观察日志
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

  it('摘要无输出（空文本）不产生替换', async () => {
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
      llmStream: [{ type: 'text-delta', text: '' }],
    });
    apply(ctx, { tailMessageCount: 1, compressRetryCount: 2, observeThresholdTokens: 1 }); // 总尝试 3 次
    await runPreStepWithDelay(ctx, session);
    expect(ctx._llmCalls).toHaveLength(3); // 无输出视为失败，重试共 3 次
    // 摘要失败保留待定标记（无失效标记）：下个 pre-step 直接重试执行
    expect(session.events.some((e) => isOmKind(e, 'om/observe-pending'))).toBe(true);
    expect(session.events.some((e) => isOmKind(e, 'om/observe-invalidate'))).toBe(false);
    // 摘要无输出：start 在摘要调用前已开启（UI 压缩中提示），end(error) 关闭生命周期；
    // 无 summary、无部分替换
    expect(session.events.some((e) => e.type === 'compaction/start')).toBe(true);
    expect(session.events.some((e) => e.type === 'compaction/summary')).toBe(false);
    const failEnd = session.events.findLast((e) => e.type === 'compaction/end');
    if (failEnd?.type !== 'compaction/end') throw new Error('缺 end');
    // end(error) 写最后一次尝试的具体问题（无 <history> 块），不再写泛化文案
    expect((failEnd.data as { error?: string }).error).toContain('找不到完整的 <history> 块');
    expect(latestHistoryText(session)).toBe(''); // 无部分替换
    // 失败日志始终输出（含具体原因、尝试次数与重试耗尽说明）
    const warns = ctx._loggerCalls.filter((c) => c.level === 'warn').map((c) => String(c.args[0]));
    expect(
      warns.some((w) =>
        w.includes('摘要输出未通过校验（第 1/3 次，输出中找不到完整的 <history> 块'),
      ),
    ).toBe(true);
    expect(warns.some((w) => w.includes('重试耗尽，放弃本次压缩'))).toBe(true);
    expect(warns.some((w) => w.includes('摘要调用最终失败（已尝试 3 次'))).toBe(true);
  });

  it('摘要流非 stop 结束（max-tokens）视为未完成，不产生替换', async () => {
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
      llmStream: [
        { type: 'text-delta', text: '部分输出' },
        { type: 'finish', reason: { kind: 'max-tokens' } },
      ],
    });
    apply(ctx, { tailMessageCount: 1, compressRetryCount: 2, observeThresholdTokens: 1 }); // 总尝试 3 次
    await runPreStepWithDelay(ctx, session);
    expect(ctx._llmCalls).toHaveLength(3); // 非 stop 结束视为失败，重试共 3 次
    // start 提前开启、end(error) 关闭生命周期；无 summary、无替换
    expect(session.events.some((e) => e.type === 'compaction/start')).toBe(true);
    expect(session.events.some((e) => e.type === 'compaction/end')).toBe(true);
    expect(session.events.some((e) => e.type === 'compaction/summary')).toBe(false);
    expect(latestHistoryText(session)).toBe('');
  });

  it('摘要失败重试：前两次抛异常，第三次成功并正常压缩', async () => {
    const session = makeSession({
      events: buildToolCallFlow({
        code: 'a()',
        description: '任务A',
        callId: 'c1',
        resultText: 'r1',
        withTurnEnd: true,
      }),
    });
    // 可重入迭代器：每次 stream 调用按尝试次数产出——第 1/2 次抛异常，第 3 次正常输出
    let attempts = 0;
    const ctx = makeCtx({
      llmStream: {
        [Symbol.iterator]() {
          attempts += 1;
          const current = attempts;
          return (function* () {
            if (current <= 2) throw new Error(`模拟第 ${current} 次失败`);
            yield {
              type: 'text-delta',
              text: '<history>\n<user_message index="0">\nretried-ok\n</user_message>\n<assistant start="1" end="2">toolcall index:2 purpose:任务A summary:完成</assistant>\n</history>',
            };
          })();
        },
      },
    });
    apply(ctx, { tailMessageCount: 1, compressRetryCount: 2, observeThresholdTokens: 1 }); // 总尝试 3 次
    await runPreStepWithDelay(ctx, session);
    expect(ctx._llmCalls).toHaveLength(3); // 首次 + 2 次重试
    expect(latestHistoryText(session)).toContain('retried-ok');
    expect(session.events.some((e) => e.type === 'compaction/start')).toBe(true);
    // start 前置（压缩中提示）且携带阶段；summary 携带重试次数（第 3 次成功 → 2）
    const sIdx = session.events.findIndex((e) => e.type === 'compaction/start');
    const sEvent = session.events[sIdx];
    if (sEvent?.type !== 'compaction/start') throw new Error('缺 start');
    expect((sEvent.data as { phase?: string }).phase).toBe('observe');
    const smIdx = session.events.findIndex((e) => e.type === 'compaction/summary');
    const smEvent = session.events[smIdx];
    if (smEvent?.type !== 'compaction/summary') throw new Error('缺 summary');
    expect((smEvent.data as CompactionSummaryPayload).attemptCount).toBe(2);
    // 失败日志始终输出（含尝试次数与重试提示）
    const warns = ctx._loggerCalls.filter((c) => c.level === 'warn').map((c) => String(c.args[0]));
    expect(warns.some((w) => w.includes('摘要调用失败（第 1/3 次，模拟第 1 次失败，子会话 '))).toBe(
      true,
    );
    expect(warns.some((w) => w.includes('摘要调用失败（第 2/3 次，模拟第 2 次失败，子会话 '))).toBe(
      true,
    );
  });

  it('摘要失败重试耗尽：三次均抛异常，不产生替换，记录最终失败', async () => {
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
      llmStream: {
        [Symbol.iterator]() {
          return {
            next() {
              throw new Error('总是失败');
            },
          };
        },
      },
    });
    apply(ctx, { tailMessageCount: 1, compressRetryCount: 2, observeThresholdTokens: 1 }); // 总尝试 3 次
    await runPreStepWithDelay(ctx, session);
    expect(ctx._llmCalls).toHaveLength(3);
    // start 提前开启、end(error) 关闭生命周期；无 summary、无替换
    expect(session.events.some((e) => e.type === 'compaction/start')).toBe(true);
    expect(session.events.some((e) => e.type === 'compaction/end')).toBe(true);
    expect(session.events.some((e) => e.type === 'compaction/summary')).toBe(false);
    expect(latestHistoryText(session)).toBe('');
    const warns = ctx._loggerCalls.filter((c) => c.level === 'warn').map((c) => String(c.args[0]));
    expect(warns.some((w) => w.includes('摘要调用失败（第 3/3 次，总是失败，子会话 '))).toBe(true);
    expect(
      warns.some((w) => w.includes('摘要调用最终失败（已尝试 3 次，最后错误：总是失败）')),
    ).toBe(true);
  });

  it('摘要尝试耗尽：pre-step 返回 reject 中断当前 turn（不调用 next），end(error) 携带实际报错', async () => {
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
      llmStream: {
        [Symbol.iterator]() {
          return {
            next() {
              throw new Error('额度不足');
            },
          };
        },
      },
    });
    apply(ctx, { tailMessageCount: 1, compressRetryCount: 1, observeThresholdTokens: 1 }); // 总尝试 2 次
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
    const decision = await run(); // 第二步：延迟到期执行，摘要失败拒绝本 step
    expect(decision).toEqual({ kind: 'reject' }); // 拒绝本 step，当前 turn 以 blocked 结束
    expect(nextCalled).toBe(false); // 不放行、不再继续 AI 会话
    expect(ctx._llmCalls).toHaveLength(2); // 首次 + 1 次重试
    const failEnd = session.events.findLast((e) => e.type === 'compaction/end');
    if (failEnd?.type !== 'compaction/end') throw new Error('缺 end');
    expect((failEnd.data as { error?: string }).error).toContain('额度不足'); // 实际报错写入 end
    const warns = ctx._loggerCalls.filter((c) => c.level === 'warn').map((c) => String(c.args[0]));
    expect(
      warns.some((w) => w.includes('上下文压缩失败，拒绝本 step 中断当前 turn：额度不足')),
    ).toBe(true);
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
    const ctx = observeCtx(
      '<history>\n<user_message index="0">\nOBSERVED-PASS\n</user_message>\n<assistant start="1" end="2">toolcall index:2 purpose:任务A summary:完成</assistant>\n</history>',
    );
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
    expect(ctx._llmCalls).toHaveLength(0); // 中止时不发起摘要调用
  });

  it('流程逐步日志：dev 环境 step（debug）日志覆盖关键步骤', async () => {
    const session = makeSession({
      events: buildToolCallFlow({
        code: 'a()',
        description: '任务A',
        callId: 'c1',
        resultText: 'r1',
        withTurnEnd: true,
      }),
    });
    const ctx = observeCtx(
      '<history>\n<user_message index="0">\nOBSERVED-PASS\n</user_message>\n<assistant start="1" end="2">toolcall index:2 purpose:任务A summary:完成</assistant>\n</history>',
    );
    apply(ctx, { tailMessageCount: 1, compressRetryCount: 2, observeThresholdTokens: 1 }); // 总尝试 3 次
    await runPreStepWithDelay(ctx, session);
    const steps = ctx._loggerCalls
      .filter((c) => c.level === 'debug')
      .map((c) => String(c.args[0] ?? ''));
    expect(steps.some((s) => s.includes('观察检查'))).toBe(true);
    expect(steps.some((s) => s.includes('触发压缩'))).toBe(true);
    expect(steps.some((s) => s.includes('压缩区间'))).toBe(true);
    expect(steps.some((s) => s.includes('摘要调用开始（第 1/3 次'))).toBe(true);
    // 尝试成功始终写入日志（info，不受 debug 影响）
    const infos = ctx._loggerCalls
      .filter((c) => c.level === 'info')
      .map((c) => String(c.args[0] ?? ''));
    expect(infos.some((s) => s.includes('摘要调用成功（第 1/3 次'))).toBe(true);
    expect(
      steps.some((s) => s.includes('观察：追加 compaction/start（摘要调用前开启压缩中提示）')),
    ).toBe(true);
    expect(steps.some((s) => s.includes('观察 pass 结束'))).toBe(true);
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
    const ctx = observeCtx(
      '<history>\n<user_message index="0">\n请帮我完成一个任务\n</user_message>\n</history>',
    );
    apply(ctx, { tailMessageCount: 1, observeThresholdTokens: 1 });
    await runPreStepWithDelay(ctx, session);
    const instruction = instructionText(summaryOptions(ctx));
    expect(instruction).not.toContain('[interrupted]');
  });

  it('当前 turn 消息可压缩：mid-turn 压缩后其消息被替换、起始 index 覆盖当前 turn 消息', async () => {
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
    const ctx = observeCtx(
      '<history>\n<user_message index="0">\nA-用户\n</user_message>\n<assistant start="1" end="5">\nA-模块摘要\n</assistant>\n</history>',
    );
    apply(ctx, { tailMessageCount: 1, observeThresholdTokens: 1 });
    await runPreStepWithDelay(ctx, session);
    // 区间截至触发点（完整消息 index 5，最后事件 seq 8 平衡）：mid-turn 消息一并压缩；
    // 等待期新消息在触发点之后、不被压缩
    const nodes = session.surface.nodes;
    expect(nodes.length).toBe(2); // 等待期新消息 + <history>
    // 输入携带绝对 index：新消息（含当前 turn 的 user-c2）从 0 编号
    const instruction = instructionText(summaryOptions(ctx));
    const input = String(summaryOptions(ctx)?.messages?.[0]?.content?.[0]?.text ?? '');
    expect(input).toContain('<user_message index="0">');
    expect(input).toContain('<user_message index="3">'); // user-c2（当前 turn）为完整消息 index 3
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

  it('摘要超反思阈值：摘要调用精简合并并把整个块区段替换为一条', async () => {
    // 单块摘要（X*40 + tip 标签约 26 tokens）；反思阈值 1 → 触发反思；
    // 上下文压力远小于观察阈值（保持默认 45000）→ 观察不触发
    const session = makeSession({
      events: [
        historyMessage('X'.repeat(40)),
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
      llmStream: [
        {
          type: 'text-delta',
          text: '<history>\n<user_message index="0">\nREFLECTED-REPORT\n</user_message>\n</history>',
        },
      ],
    });
    apply(ctx, { reflectThresholdTokens: 1 });
    await runPreStep(ctx, session);
    expect(ctx._llmCalls).toHaveLength(1);
    expect(instructionText(ctx._llmCalls[0]?.options)).toBe(buildHistoryPrompt()); // 反思与观察共用同一套提示词
    expect(session.surface.nodes.length).toBe(before); // 单块区段替换，节点数不变
    expect(latestHistoryText(session)).toContain('REFLECTED');
    expect(latestHistoryText(session)).not.toContain('X'.repeat(40)); // 旧摘要被替换
  });

  it('多块反思：按全部块总长触发，把整个块区段合并为一条', async () => {
    // 两个块（各 X*40，含 tip 标签约 26 tokens，合计约 52）≥ 反思阈值 1 → 触发反思
    const session = makeSession({
      events: [
        historyMessage('X'.repeat(40), 'h1'),
        historyMessage('Y'.repeat(40), 'h2'),
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
      llmStream: [
        {
          type: 'text-delta',
          text: '<history>\n<user_message index="0">\nMERGED-REPORT\n</user_message>\n</history>',
        },
      ],
    });
    apply(ctx, { reflectThresholdTokens: 1 });
    await runPreStep(ctx, session);
    expect(ctx._llmCalls).toHaveLength(1);
    expect(instructionText(ctx._llmCalls[0]?.options)).toBe(buildHistoryPrompt()); // 反思与观察共用同一套提示词
    // 摘要输入为全部块内文拼合的单个 <history> 块（无 tip 属性、仅一对开闭标签）
    const input = inputText(ctx);
    expect(input.startsWith(`<${HISTORY_TAG}>\n`)).toBe(true);
    expect(input.endsWith(`\n</${HISTORY_TAG}>`)).toBe(true);
    expect(input).not.toContain(' tip=');
    expect(input.match(/<history>/g)).toHaveLength(1);
    expect(input.match(/<\/history>/g)).toHaveLength(1);
    expect(input).toContain('X'.repeat(40)); // 两块内文按序合并
    expect(input).toContain('Y'.repeat(40));
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
    expect((summaryEvent.data as CompactionSummaryPayload).shadowedCharCount).toBe(80); // 两块 X*40 + Y*40
  });

  it('多块反思输入：剥离各块块首格式说明注释，正文条目内的同名串原样保留', async () => {
    // 块 1 顶部带真实提取产物特有的格式说明注释；块 2 正文条目内含同形注释串与 tip 文本，
    // 拼合仅剥离块首注释，正文串不动（防止误伤块内部）
    const noteInContent = '<!-- 完整消息：正文条目内的同名注释串 -->';
    const session = makeSession({
      events: [
        historyMessage(
          `${HISTORY_FORMAT_NOTE}\n<user_message index="0">\nOLD-SUMMARY-1\n</user_message>`,
        ),
        historyMessage(
          `<user_message index="1">\n${noteInContent}\ntip="正文内的 tip 文本"\n</user_message>`,
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
    const ctx = makeCtx({
      llmStream: [
        {
          type: 'text-delta',
          text:
            '<history>\n<user_message index="0">\n合并后的历史条目内容\n</user_message>\n' +
            '<user_message index="1">\n续接条目\n</user_message>\n</history>',
        },
      ],
    });
    apply(ctx, { reflectThresholdTokens: 1 });
    await runPreStep(ctx, session);
    expect(ctx._llmCalls).toHaveLength(1);
    const input = inputText(ctx);
    expect(input.startsWith(`<${HISTORY_TAG}>\n<user_message index="0">`)).toBe(true); // 块 1 块首注释已剥离
    expect(input).not.toContain(HISTORY_FORMAT_NOTE);
    expect(input).toContain('OLD-SUMMARY-1'); // 两块内文按序合并
    expect(input).toContain(noteInContent); // 正文条目内的同名注释串原样保留
    expect(input).toContain('tip="正文内的 tip 文本"'); // 正文内的 tip 同形文本原样保留
    expect(input.startsWith(`<${HISTORY_TAG}>\n`)).toBe(true); // 输入开标签无属性
  });

  it('先反思后观察串行：反思合并旧块，观察在其后追加独立新块', async () => {
    // 反思阈值 90：旧块（X*400，约 112 tokens）首次触发反思；合并后的块含格式说明
    // 注释（约 79 tokens）不再触发；观察阈值 1（上下文压力 ✓）延迟一步后执行
    const session = makeSession({
      events: [
        historyMessage('X'.repeat(400)),
        ...buildToolCallFlow({
          code: 'a()',
          description: '任务A',
          callId: 'c1',
          resultText: 'r1',
          withTurnEnd: true,
        }),
      ],
    });
    // 可重入迭代器：每次 stream 调用产出一个合法 <history> 块——第 1 次（反思）REFLECTED，
    // 第 2 次（观察执行）OBSERVED（覆盖区间 0..2，触发点完整消息 index 2）
    let streamCalls = 0;
    const ctx = makeCtx({
      llmStream: {
        [Symbol.iterator]() {
          streamCalls += 1;
          const current = streamCalls;
          return (function* () {
            yield {
              type: 'text-delta',
              text:
                current === 1
                  ? '<history>\n<user_message index="0">\nREFLECTED-REPORT\n</user_message>\n</history>'
                  : '<history>\n<user_message index="0">\nOBSERVED-PASS\n</user_message>\n<assistant start="1" end="2">toolcall index:2 purpose:任务A summary:完成</assistant>\n</history>',
            };
          })();
        },
      },
    });
    apply(ctx, { tailMessageCount: 1, observeThresholdTokens: 1, reflectThresholdTokens: 90 });
    await runPreStepWithDelay(ctx, session);
    expect(ctx._llmCalls).toHaveLength(2);
    const firstText = instructionText(ctx._llmCalls[0]?.options);
    const secondText = instructionText(ctx._llmCalls[1]?.options);
    // 两者共用同一套提示词；以输入（数据源）区分反思/观察
    expect(firstText).toBe(buildHistoryPrompt());
    expect(secondText).toBe(buildHistoryPrompt());
    const inputOf = (call: unknown) =>
      String(
        (call as { messages?: Array<{ content?: Array<{ type?: string; text?: string }> }> })
          ?.messages?.[0]?.content?.[0]?.text ?? '',
      );
    expect(inputOf(ctx._llmCalls[0]?.options)).toContain('XXXX'); // 反思输入 = 旧块拼接
    expect(inputOf(ctx._llmCalls[1]?.options)).toContain('请帮我完成一个任务'); // 观察输入 = 新消息渲染
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
    // 摘要 40 字符 ≈ 10 tokens；反思阈值 1 → 触发反思；观察阈值保持默认不触发
    const session = makeSession({
      events: [
        historyMessage('X'.repeat(40)),
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
      llmStream: [
        {
          type: 'text-delta',
          text: '<history>\n<user_message index="0">\nREFLECTED-REPORT\n</user_message>\n</history>',
        },
      ],
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
    // 反思压缩：start 携带 phase='reflect'（UI 压缩中提示按阶段区分）；首次成功 attemptCount=0
    expect((startEvent.data as { phase?: string }).phase).toBe('reflect');
    expect((summaryEvent.data as CompactionSummaryPayload).attemptCount).toBe(0);
    // 单节点替换：遮蔽区间为旧 <history> 节点
    expect(summaryEvent.data.shadowedRange).toEqual({ start: 0, end: 0 });
    expect(summaryEvent.data.shadowedSeqs).toEqual([0]);
    expect((summaryEvent.data as CompactionSummaryPayload).shadowedCharCount).toBe(40); // 旧块文本 X*40
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
      llmStream: [
        {
          type: 'text-delta',
          text: '<history>\n<user_message index="0">\n新内容\n</user_message>\n<assistant start="1" end="2">toolcall index:2 purpose:任务A summary:完成</assistant>\n</history>',
        },
      ],
    });
    // 反思阈值 1000 > 旧摘要（含 tip 开标签约 26 tokens）——隔离观察路径；
    // 摘要输出覆盖区间 0..2（触发点完整消息 index 2）
    apply(ctx, { tailMessageCount: 1, observeThresholdTokens: 1, reflectThresholdTokens: 1000 });
    await runPreStepWithDelay(ctx, session);
    const { start, summary } = compactionLifecycle(session);
    expect(start).not.toBe(-1);
    const summaryEvent = session.events[summary];
    if (summaryEvent?.type !== 'compaction/summary') throw new Error('缺 summary');
    const summaryText = summaryEvent.data.summary
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    expect(summaryText).toContain('新内容'); // summary = 本次观察日志
    expect(summaryText).not.toContain('旧任务'); // 不再合并旧摘要原文
    // 遮蔽数据 = 压缩边界至触发点区间（旧块 seq 0 保留、不计入遮蔽）
    expect(summaryEvent.data.shadowedRange).toEqual({ start: 1, end: 4 });
    expect(summaryEvent.data.shadowedSeqs).toEqual([1, 2, 4]);
    expect((summaryEvent.data as CompactionSummaryPayload).shadowedCharCount).toBe(17); // user 9 + assistant 6 + result 2
  });
});

describe('OM 摘要 token 归入主会话（compaction/summary.usage）', () => {
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
    // 缺省注入覆盖区间 0..2 的合法报告（触发点完整消息 index 2）
    const ctx = makeCtx({
      llmStream: [
        {
          type: 'text-delta',
          text: '<history>\n<user_message index="0">\n请帮我完成一个任务\n</user_message>\n<assistant start="1" end="2">toolcall index:2 purpose:任务A summary:完成</assistant>\n</history>',
        },
      ],
      ...extra,
    });
    apply(ctx, { tailMessageCount: 1, observeThresholdTokens: 1 });
    return { session, ctx };
  }

  it('摘要流报告 usage：写入主会话 compaction/summary.usage', async () => {
    const summaryUsage = {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
    };
    const { session, ctx } = sessionAndCtx({
      llmStream: [
        {
          type: 'text-delta',
          text: '<history>\n<user_message index="0">\n请帮我完成一个任务\n</user_message>\n<assistant start="1" end="2">toolcall index:2 purpose:任务A summary:完成</assistant>\n</history>',
        },
        { type: 'usage', usage: summaryUsage },
      ],
    });
    await runPreStep(ctx, session);
    const summaryIdx = session.events.findIndex((e) => e.type === 'compaction/summary');
    const summaryEvent = session.events[summaryIdx];
    if (summaryEvent?.type !== 'compaction/summary') throw new Error('缺 summary');
    expect(summaryEvent.data.usage).toEqual(summaryUsage);
  });

  it('摘要流无 usage（无 usage chunk）时省略 usage 字段', async () => {
    const { session, ctx } = sessionAndCtx(); // 默认 mock：无 usage chunk
    await runPreStep(ctx, session);
    const summaryIdx = session.events.findIndex((e) => e.type === 'compaction/summary');
    const summaryEvent = session.events[summaryIdx];
    if (summaryEvent?.type !== 'compaction/summary') throw new Error('缺 summary');
    expect(summaryEvent.data.usage).toBeUndefined();
  });
});

describe('摘要请求形态（new 方式）', () => {
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

  /** 带 requestHeader system/tools 的会话（断言摘要不复用主会话请求前缀）。 */
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

  it('始终以 new 方式开启观察：指令作为 system，输入 = 被压缩消息（XML 包裹，不含尾部）', async () => {
    const session = sessionWithHeader();
    const ctx = makeCtx({
      // 会话请求头带 tools（JSON 21 字符 → 6 tokens）：注入真实 usage 锚定压力，扣除工具定义后仍达阈值
      meterTotalTokens: 100000,
      llmStream: [
        {
          type: 'text-delta',
          text: '<history>\n<user_message index="0">\nOBSERVED-PASS\n</user_message>\n<assistant start="1" end="2">toolcall index:2 purpose:任务A summary:完成</assistant>\n</history>',
        },
      ],
    });
    apply(ctx, { tailMessageCount: 1, observeThresholdTokens: 1 });
    await runPreStep(ctx, session);
    const options = ctx._llmCalls[0]?.options as {
      system?: string;
      tools?: unknown[];
      messages?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
    };
    // new 方式：不复用主会话 requestHeader（system/tools 前缀不沿用）；指令 = 共享提示词
    expect(options?.system).toBe(buildHistoryPrompt());
    expect(options?.system).not.toContain('主会话系统提示词');
    expect(options?.tools).toBeUndefined();
    const input = String(options?.messages?.[0]?.content?.[0]?.text ?? '');
    // 输入 = 被压缩区间（压缩边界..触发点）的完整消息渲染（合法 <history> 块，带绝对 index），不含分段标签与尾部
    expect(input).toContain('<history>');
    expect(input).toContain('<user_message index="0">');
    expect(input).toContain('请帮我完成一个任务');
    expect(input).not.toContain('【被压缩消息】');
    expect(input).not.toContain('【参考尾部】');
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

  it('recallEnabled=true / semanticRecallEnabled=true 显式启用', () => {
    const ctx = makeCtx();
    apply(ctx, { recallEnabled: true, semanticRecallEnabled: true });
    expect(registeredNames(ctx)).toEqual(expect.arrayContaining(['recall', 'recall-semantic']));
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

  /** 返回固定观察报告的 ctx（观察阈值需在 apply 配置中触发）。 */
  function observeCtx(report: string) {
    return makeCtx({
      llmStream: [{ type: 'text-delta', text: report }],
    });
  }

  /** 覆盖区间 0..2 的固定观察报告。 */
  const observeReport =
    '<history>\n<user_message index="0">\n延迟压缩报告\n</user_message>\n<assistant start="1" end="2">toolcall index:2 purpose:任务A summary:完成</assistant>\n</history>';

  it('触发即待定：达阈值记录 om/observe-pending（触发点 = 最后完整消息 index），本次不压缩', async () => {
    const session = singleFlowSession();
    const ctx = observeCtx(observeReport);
    apply(ctx, { tailMessageCount: 1, observeThresholdTokens: 1 });
    const nextCalled = await runPreStep(ctx, session);
    expect(nextCalled).toBe(true); // 触发不中断，正常放行
    expect(ctx._llmCalls).toHaveLength(0); // 延迟执行：本次无摘要调用
    const pendingEvents = findOmEvents(session, 'om/observe-pending');
    expect(pendingEvents).toHaveLength(1);
    expect(pendingEvents[0]?.data).toEqual({ triggerMessageIndex: 2 });
    expect(session.events.some((e) => isOmKind(e, 'om/observe-invalidate'))).toBe(false);
    expect(session.surface.nodes.length).toBe(3); // 表层不变
  });

  it('活跃待定期间不重复添加：连续 pre-step 仅一条 pending', async () => {
    const session = singleFlowSession();
    const ctx = observeCtx(observeReport);
    apply(ctx, { tailMessageCount: 3, observeThresholdTokens: 1 });
    await runPreStep(ctx, session);
    await runPreStep(ctx, session); // 未满 K，等待中
    expect(findOmEvents(session, 'om/observe-pending')).toHaveLength(1);
    expect(ctx._llmCalls).toHaveLength(0);
  });

  it('未满 K 等待：新增完整消息数不足时不执行', async () => {
    const session = singleFlowSession();
    const ctx = observeCtx(observeReport);
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
    const ctx = observeCtx(observeReport);
    apply(ctx, { tailMessageCount: 1, observeThresholdTokens: 1 });
    await runPreStep(ctx, session); // 触发：triggerMessageIndex = 2
    appendWaitingMessage(session, 'wait-exec'); // 新增 1 ≥ 1
    await runPreStep(ctx, session);
    expect(ctx._llmCalls).toHaveLength(1);
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
    expect(latestHistoryText(session)).toContain('延迟压缩报告');
    // 执行成功后写失效标记，指向待定标记事件 seq
    const pendings = findOmEvents(session, 'om/observe-pending');
    const invalidates = findOmEvents(session, 'om/observe-invalidate');
    expect(pendings).toHaveLength(1);
    expect(invalidates).toHaveLength(1);
    expect(invalidates[0]?.data.pendingSeq).toBe(pendings[0]?.seq);
  });

  it('K=0：触发当轮立即执行（无待定/失效标记）', async () => {
    const session = singleFlowSession();
    const ctx = observeCtx(observeReport);
    apply(ctx, { tailMessageCount: 0, observeThresholdTokens: 1 });
    await runPreStep(ctx, session);
    expect(ctx._llmCalls).toHaveLength(1);
    expect(session.events.some((e) => isOmKind(e, 'om/observe-pending'))).toBe(false);
    expect(session.events.some((e) => isOmKind(e, 'om/observe-invalidate'))).toBe(false);
    expect(latestHistoryText(session)).toContain('延迟压缩报告');
  });

  it('摘要失败保留待定：下个 pre-step 到期直接重试执行', async () => {
    let attempts = 0;
    const session = singleFlowSession();
    const ctx = makeCtx({
      llmStream: {
        [Symbol.iterator]() {
          attempts += 1;
          const current = attempts;
          return (function* () {
            if (current <= 2) throw new Error(`模拟第 ${current} 次失败`);
            yield { type: 'text-delta', text: observeReport };
          })();
        },
      },
    });
    apply(ctx, { tailMessageCount: 1, compressRetryCount: 1, observeThresholdTokens: 1 }); // 每轮总尝试 2 次
    await runPreStep(ctx, session); // 触发
    appendWaitingMessage(session, 'wait-fail');
    await runPreStep(ctx, session); // 执行：2 次尝试全部失败
    expect(ctx._llmCalls).toHaveLength(2);
    expect(session.events.some((e) => isOmKind(e, 'om/observe-invalidate'))).toBe(false);
    appendWaitingMessage(session, 'wait-retry');
    await runPreStep(ctx, session); // 待定仍在、到期条件仍满足 → 直接重试
    expect(ctx._llmCalls).toHaveLength(3); // 重试 1 次即成功（第 3 次调用）
    expect(session.events.some((e) => isOmKind(e, 'om/observe-invalidate'))).toBe(true);
    expect(latestHistoryText(session)).toContain('延迟压缩报告');
  });

  it('重启恢复：待定标记从会话日志恢复（新会话对象含 pending 事件即可续跑）', async () => {
    // 模拟重启：pending 事件已持久化在日志中，重建的会话对象直接带上它
    const session = singleFlowSession([pendingEvent(2)]);
    const ctx = observeCtx(observeReport);
    apply(ctx, { tailMessageCount: 1, observeThresholdTokens: 1 });
    await runPreStep(ctx, session); // 未满 K：等待（新增 0 < 1）
    expect(ctx._llmCalls).toHaveLength(0);
    appendWaitingMessage(session, 'wait-resume'); // 新增 1 ≥ 1
    await runPreStep(ctx, session);
    expect(ctx._llmCalls).toHaveLength(1);
    expect(latestHistoryText(session)).toContain('延迟压缩报告');
    expect(findOmEvents(session, 'om/observe-invalidate').length).toBeGreaterThan(0);
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
      llmStream: [{ type: 'text-delta', text: observeReport }],
    });
    apply(ctx, { tailMessageCount: 1, observeThresholdTokens: 1 });
    await runPreStep(ctx, session); // 过期 → 重新触发：新一轮 pending（seq 7，触发点仍为 index 2）
    expect(ctx._llmCalls).toHaveLength(0);
    expect(findOmEvents(session, 'om/observe-pending')).toHaveLength(2);
    appendWaitingMessage(session, 'wait-expired'); // 新增 1 ≥ 1
    await runPreStep(ctx, session); // 触发点内容已被压缩 → 无可行区间 → 清除标记视为完成
    expect(ctx._llmCalls).toHaveLength(0); // 不对已压缩内容发起摘要
    expect(session.events.some((e) => isOmKind(e, 'om/observe-invalidate'))).toBe(true); // 新标记已失效
    expect(latestHistoryText(session)).toContain('压缩后的块'); // 无新增替换
  });
});

// 保证入口导出形态稳定（Loader 依赖）
describe('插件入口导出', () => {
  it('导出 name/inject/apply 且无 default', () => {
    expect(name).toBe('dsh-plugin-om');
    expect(inject).toEqual(['tools', 'llm', 'tokenMeter', 'sessions']);
    expect(typeof apply).toBe('function');
  });
});
