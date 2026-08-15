// dsh-plugin-om 单元测试（vitest）：配置校验 / 消息索引 /
// OM 两级压缩（观察/反思 fork 摘要）/ recall（范围+拒绝+参数校验）/ apply 接线。
import { describe, expect, it } from 'vitest';
import {
  buildMessageIdTable,
  computeCompressRange,
  estimateTextTokens,
  extractHistoryText,
  findLatestHistory,
  measureUncompressedTokens,
  scanInterruptions,
} from '../src/compress.ts';
import { resolveConfig } from '../src/config.ts';
import { HISTORY_TAG, PLUGIN_LABEL } from '../src/constants.ts';
import { apply, inject, name } from '../src/index.ts';
import { indexMessages, messageIdOfEvent } from '../src/log-index.ts';
import { buildRecallTool, parseRecallArgs } from '../src/recall.ts';
import {
  buildObservePrompt,
  buildReflectPrompt,
  OBSERVER_PERSONA,
  REFLECTOR_PERSONA,
} from '../src/summarize.ts';
import type { Session, SessionEvent } from '../src/types.ts';
import {
  buildToolCallFlow,
  makeCtx,
  makeMessage,
  makeMeter,
  makeSession,
  textBlock,
} from './helpers.ts';

/** 从会话日志提取最后一次 <om-history> 消息的完整文本（去标签）。 */
function latestHistoryText(session: Session): string {
  const historyMsg = session.events.findLast(
    (e) =>
      e.type === 'user/message' &&
      String(
        ((e.data as { content?: unknown[] }).content?.[0] as { text?: string } | undefined)?.text ??
          '',
      ).includes(`<${HISTORY_TAG}>`),
  );
  const text = String(
    (
      (historyMsg as { data?: { content?: unknown[] } } | undefined)?.data?.content?.[0] as
        | { text?: string }
        | undefined
    )?.text ?? '',
  );
  return text.replace(new RegExp(`</?${HISTORY_TAG}>`, 'g'), '').trim();
}

/** 构造 <om-history> 压缩日志消息（插件自产 user/message，seq 从 0 起）。 */
function historyMessage(inner: string, id = 'history-msg'): SessionEvent {
  return {
    type: 'user/message',
    data: makeMessage({
      content: [textBlock(`<${HISTORY_TAG}>\n${inner}\n</${HISTORY_TAG}>`)],
      source: { kind: 'plugin', plugin: PLUGIN_LABEL },
      id,
    }),
  } as unknown as SessionEvent;
}

/** 构造两条 run_code 流程（消息序列纯净：0 user-c1, 1 assistant-c1, 2 result-c1, 3 user-c2, ...）。 */
function twoCallFlow(): SessionEvent[] {
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

describe('配置校验 resolveConfig', () => {
  it('默认值正确（historyMergeRatio 默认 0.2）', () => {
    const d = resolveConfig({});
    expect(d.thresholdRatio).toBe(0.5);
    expect(d.historyMergeRatio).toBe(0.2);
    expect(d.compressMaxTokens).toBe(4096);
    expect(d.tailMessageCount).toBe(10);
    expect(d).not.toHaveProperty('summaryMaxChars');
    expect(d).not.toHaveProperty('recallMaxMessages');
    expect(d).not.toHaveProperty('auto');
    expect(d).not.toHaveProperty('evalEnabled');
  });

  it('覆盖项生效', () => {
    const c = resolveConfig({ thresholdRatio: 0.7, historyMergeRatio: 0.3 });
    expect(c.thresholdRatio).toBe(0.7);
    expect(c.historyMergeRatio).toBe(0.3);
  });

  it('tailMessageCount 校验：默认 10，正整数可覆盖，非正整数抛错', () => {
    expect(resolveConfig({}).tailMessageCount).toBe(10);
    expect(resolveConfig({ tailMessageCount: 3 }).tailMessageCount).toBe(3);
    expect(() => resolveConfig({ tailMessageCount: 0 })).toThrow();
    expect(() => resolveConfig({ tailMessageCount: 2.5 })).toThrow();
  });

  it('整份配置留空（undefined/null/空串/空白串）时全部用默认值', () => {
    const empty = [undefined, null, '', '   '];
    for (const raw of empty) {
      const d = resolveConfig(raw);
      expect(d.thresholdRatio).toBe(0.5);
      expect(d.historyMergeRatio).toBe(0.2);
      expect(d.compressMaxTokens).toBe(4096);
      expect(d.tailMessageCount).toBe(10);
    }
  });

  it('单项留空（null/空串/undefined）该键用默认值，其余覆盖项仍生效', () => {
    expect(resolveConfig({ thresholdRatio: null }).thresholdRatio).toBe(0.5);
    expect(resolveConfig({ thresholdRatio: '' }).thresholdRatio).toBe(0.5);
    const mixed = resolveConfig({ thresholdRatio: undefined, historyMergeRatio: 0.3 });
    expect(mixed.thresholdRatio).toBe(0.5);
    expect(mixed.historyMergeRatio).toBe(0.3);
    const mixed2 = resolveConfig({ compressMaxTokens: null, tailMessageCount: 3 });
    expect(mixed2.compressMaxTokens).toBe(4096);
    expect(mixed2.tailMessageCount).toBe(3);
  });

  it('未知键与越界数值抛错', () => {
    expect(() => resolveConfig([])).toThrow(); // 空数组不是对象
    expect(() => resolveConfig('0.5')).toThrow(); // 非空字符串不是对象
    expect(() => resolveConfig({ badKey: 1 })).toThrow();
    expect(() => resolveConfig({ thresholdRatio: 2 })).toThrow();
    expect(() => resolveConfig({ summaryMaxChars: 100 })).toThrow();
    expect(() => resolveConfig({ historyMergeRatio: 0 })).toThrow(); // 仍校验区间
    expect(() => resolveConfig({ historyMergeRatio: 2 })).toThrow();
    expect(() => resolveConfig({ recallMaxMessages: 10 })).toThrow();
    expect(() => resolveConfig({ tailMessageBudget: 50 })).toThrow();
    expect(() => resolveConfig({ tailTokenBudgetRatio: 0.1 })).toThrow();
    expect(() => resolveConfig({ auto: false })).toThrow();
    expect(() => resolveConfig({ evalEnabled: false })).toThrow();
  });
});

describe('消息索引 indexMessages / messageIdOfEvent', () => {
  it('按日志顺序索引 user/assistant/tool-result 消息并按 message_id 定位', () => {
    const session = makeSession({
      events: [
        ...buildToolCallFlow({
          code: 'a()',
          description: '任务A',
          callId: 'c1',
          resultText: 'r1',
          userMessageId: 'u1',
          assistantMessageId: 'a1',
          resultMessageId: 'r1m',
        }),
      ],
    });
    const { messages, byId } = indexMessages(session);
    expect(messages.map((m) => m.id)).toEqual(['u1', 'a1', 'r1m']);
    expect(byId.get('u1')).toBe(0);
    expect(byId.get('a1')).toBe(1);
    expect(byId.get('r1m')).toBe(2);
    expect(byId.get('nope')).toBeUndefined();
  });

  it('插件自产压缩日志消息也有 message_id（messageIdOfEvent 覆盖 user/message）', () => {
    const session = makeSession({ events: [historyMessage('旧任务', 'history-msg')] });
    const { messages, byId } = indexMessages(session);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe('history-msg');
    expect(byId.get('history-msg')).toBe(0);
    const id = messageIdOfEvent(session.events[0]);
    expect(id).toBe('history-msg');
    expect(messageIdOfEvent(undefined)).toBeUndefined();
    expect(
      messageIdOfEvent({
        type: 'turn/end',
        data: { turn: 1, reason: { kind: 'completed' } },
      } as unknown as SessionEvent),
    ).toBeUndefined();
  });
});

describe('token 估算 estimateTextTokens', () => {
  it('4 字符 ≈ 1 token（与宿主启发式一致）', () => {
    expect(estimateTextTokens('')).toBe(0);
    expect(estimateTextTokens('abcd')).toBe(1);
    expect(estimateTextTokens('abcde')).toBe(2);
    expect(estimateTextTokens('abcdefgh')).toBe(2);
  });
});

describe('未压缩消息测量 measureUncompressedTokens', () => {
  it('表层节点合计，不含 <om-history> 摘要节点', () => {
    const flow = buildToolCallFlow({
      code: 'a()',
      description: '任务A',
      callId: 'c1',
      resultText: 'r1',
    });
    const plain = makeSession({ events: flow });
    const withHistory = makeSession({ events: [historyMessage('旧任务'), ...flow] });
    const meter = makeMeter();
    expect(measureUncompressedTokens(plain, meter)).toBeGreaterThan(0);
    expect(measureUncompressedTokens(withHistory, meter)).toBe(
      measureUncompressedTokens(plain, meter),
    ); // 摘要节点不计入未压缩消息
  });

  it('空表层为 0', () => {
    expect(measureUncompressedTokens(makeSession(), makeMeter())).toBe(0);
  });
});

describe('观察压缩区间 computeCompressRange', () => {
  /** 单条 runcode 流程 + turn/end：events 0..4，表层 [0,1,3]。 */
  function singleFlow() {
    return buildToolCallFlow({
      code: 'a()',
      description: '任务A',
      callId: 'c1',
      resultText: 'r1',
      withTurnEnd: true,
    });
  }

  it('尾部保留 tailCount 条，其余全部压缩', () => {
    const session = makeSession({ events: singleFlow() });
    expect(computeCompressRange(session, 1)).toEqual({
      start: 0,
      end: 1,
      shadowedSeqs: [0, 1],
      lastEndSeq: 4,
    });
    expect(computeCompressRange(session, 0)).toEqual({
      start: 0,
      end: 3,
      shadowedSeqs: [0, 1, 3],
      lastEndSeq: 4,
    });
  });

  it('当前 turn 消息不压缩：区间封顶在最后一个已结束 turn 的表层节点', () => {
    // 第二个流程没有 turn/end：模拟当前 turn 进行中，其消息已在表层但 fork seed 不可见
    const events = [
      ...singleFlow(),
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
    const range = computeCompressRange(session, 1);
    expect(range).toEqual({ start: 0, end: 3, shadowedSeqs: [0, 1, 3], lastEndSeq: 4 });
  });

  it('无 turn/end 时返回 undefined', () => {
    const flow = buildToolCallFlow({
      code: 'a()',
      description: '任务A',
      callId: 'c1',
      resultText: 'r1',
    });
    expect(computeCompressRange(makeSession({ events: flow }), 1)).toBeUndefined();
  });

  it('尾部条数 ≥ 表层节点数时返回 undefined', () => {
    expect(computeCompressRange(makeSession({ events: singleFlow() }), 5)).toBeUndefined();
  });

  it('空表层返回 undefined', () => {
    expect(computeCompressRange(makeSession(), 1)).toBeUndefined();
  });
});

describe('中断扫描 scanInterruptions', () => {
  it('aborted（含 cause）与 interrupted 产生标记，completed 不产生', () => {
    const events: SessionEvent[] = [
      ...buildToolCallFlow({ code: 'a()', description: '任务A', callId: 'c1', resultText: 'r1' }),
      {
        type: 'turn/end',
        data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } },
      } as unknown as SessionEvent,
      ...buildToolCallFlow({
        code: 'b()',
        description: '任务B',
        callId: 'c2',
        resultText: 'r2',
        userMessageId: 'user-c2',
        assistantMessageId: 'assistant-c2',
        resultMessageId: 'result-c2',
      }),
      {
        type: 'turn/end',
        data: { turn: 2, reason: { kind: 'interrupted' } },
      } as unknown as SessionEvent,
      {
        type: 'turn/end',
        data: { turn: 3, reason: { kind: 'completed' } },
      } as unknown as SessionEvent,
    ];
    const session = makeSession({ events });
    const marks = scanInterruptions(session, -1, 9); // 含 turn 1/2 的 turn/end，不含 turn 3
    expect(marks).toEqual([
      '[interrupted] turn 1 被中断（aborted，原因 user）',
      '[interrupted] turn 2 因崩溃恢复中断（interrupted）',
    ]);
  });

  it('范围外事件不产生标记', () => {
    const events: SessionEvent[] = [
      ...buildToolCallFlow({ code: 'a()', description: '任务A', callId: 'c1', resultText: 'r1' }),
      {
        type: 'turn/end',
        data: { turn: 1, reason: { kind: 'interrupted' } },
      } as unknown as SessionEvent,
    ];
    expect(scanInterruptions(makeSession({ events }), -1, 3)).toEqual([]); // turn/end@4 不在 (from..to]
  });
});

describe('历史提取 extractHistoryText / findLatestHistory', () => {
  it('extractHistoryText 按表层顺序取最后一次 <om-history>', () => {
    const session = makeSession({
      events: [
        historyMessage('旧任务'),
        ...buildToolCallFlow({ code: 'a()', description: '任务A', callId: 'c1', resultText: 'r1' }),
      ],
    });
    const found = extractHistoryText(session, [0, 1, 2, 4]);
    expect(found?.seq).toBe(0);
    expect(found?.text).toContain('旧任务');
    expect(
      extractHistoryText(makeSession({ events: [historyMessage('旧任务')] }), [1, 2]),
    ).toBeUndefined();
  });

  it('findLatestHistory 取日志中最后一次 <om-history>', () => {
    const second = historyMessage('新任务', 'history-msg-2');
    const session = makeSession({
      events: [
        historyMessage('旧任务'),
        ...buildToolCallFlow({ code: 'a()', description: '任务A', callId: 'c1', resultText: 'r1' }),
        second,
      ],
    });
    const found = findLatestHistory(session);
    expect(found?.seq).toBeGreaterThan(0);
    expect(found?.text).toContain('新任务');
    expect(
      findLatestHistory(
        makeSession({
          events: buildToolCallFlow({
            code: 'a()',
            description: '任务A',
            callId: 'c1',
            resultText: 'r1',
          }),
        }),
      ),
    ).toBeUndefined();
  });
});

describe('message_id 对照表 buildMessageIdTable', () => {
  it('按序列出 user/assistant/tool-result 的 message_id（tool-result 附 callId）', () => {
    const flow = buildToolCallFlow({
      code: 'a()',
      description: '任务A',
      callId: 'c1',
      resultText: 'r1',
      userMessageId: 'u1',
      assistantMessageId: 'a1',
      resultMessageId: 'r1m',
    });
    const session = makeSession({ events: flow }); // 表层 [0,1,3]
    expect(buildMessageIdTable(session, [0, 1, 3])).toEqual([
      '[user] message_id=u1',
      '[assistant] message_id=a1',
      '[tool/result callId=c1] message_id=r1m',
    ]);
  });

  it('插件自产 user/message 不入表', () => {
    const flow = buildToolCallFlow({
      code: 'a()',
      description: '任务A',
      callId: 'c1',
      resultText: 'r1',
    });
    const session = makeSession({
      events: [
        historyMessage('旧任务'),
        ...flow,
        {
          type: 'user/message',
          data: makeMessage({
            content: [textBlock('运行时上下文快照')],
            source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' },
            id: 'snap',
          }),
        } as unknown as SessionEvent,
      ],
    });
    const rows = buildMessageIdTable(session, [0, 1, 2, 4, 5]);
    expect(rows.some((row) => row.includes('history-msg'))).toBe(false);
    expect(rows.some((row) => row.includes('snap'))).toBe(false);
    expect(rows).toHaveLength(3); // 仅 user/assistant/tool-result
  });
});

describe('观察提示词 buildObservePrompt', () => {
  it('含聚合规则（不限于 run_code）/对照表/中断标记/追加说明', () => {
    const prompt = buildObservePrompt({
      table: ['[user] message_id=u1', '[tool/result callId=c1] message_id=r1'],
      interruptions: ['[interrupted] turn 1 被中断（aborted，原因 user）'],
      hasOldHistory: true,
    });
    expect(prompt).toContain('user_message message_id:<id> text:<要点>');
    expect(prompt).toContain('toolcall message_id:<该组最后一条消息的 message_id>');
    expect(prompt).toContain('不限于 run_code');
    expect(prompt).toContain('当前进度与下一步');
    expect(prompt).toContain('recall 按 message_id 回看');
    expect(prompt).toContain('[interrupted] turn 1 被中断（aborted，原因 user）');
    expect(prompt).toContain('[user] message_id=u1');
    expect(prompt).toContain('[tool/result callId=c1] message_id=r1');
    expect(prompt).toContain('追加到上一次压缩产物');
  });

  it('首次压缩（无旧摘要）表述为第一条日志', () => {
    const prompt = buildObservePrompt({ table: [], interruptions: [], hasOldHistory: false });
    expect(prompt).toContain('第一条 <om-history> 压缩日志');
    expect(prompt).not.toContain('追加到上一次压缩产物');
  });
});

describe('反思提示词 buildReflectPrompt', () => {
  it('精简合并规则：用户消息保留要点、toolcall 聚合、可写（略）', () => {
    const prompt = buildReflectPrompt();
    expect(prompt).toContain('精简合并');
    expect(prompt).toContain('user_message message_id:<id> text:<要点>');
    expect(prompt).toContain('（略）');
    expect(prompt).toContain('替换当前的 <om-history> 块内容');
  });
});

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

  /** 返回固定观察报告的 ctx（默认 window 8：观察阈值 4 tokens，必然触发）。 */
  function observeCtx(report: string, calls: { n: number }, window = 8) {
    return makeCtx({
      resolveModelInfo: async () => ({ context: { contextWindow: window } }),
      subagentStart: async () => {
        calls.n += 1;
        return {
          result: Promise.resolve({ output: [textBlock(report)], stopReason: 'completed' }),
          dispose: async () => {},
        };
      },
    });
  }

  it('触发观察：fork 摘要 → 追加为 <om-history>，替换被压缩区间', async () => {
    const flowEvents = buildToolCallFlow({
      code: 'runMe()',
      description: '跑一下',
      callId: 'c-eval',
      resultText: 'done',
      withTurnEnd: true,
    });
    const session = makeSession({ events: flowEvents });
    const report =
      'user_message message_id:user-c-eval text:请帮我完成一个任务\ntoolcall message_id:result-c-eval purpose:跑一下 summary:产物符合预期；下一步提交';
    const calls = { n: 0 };
    const ctx = observeCtx(report, calls);
    apply(ctx, { tailMessageCount: 1 });

    expect(ctx._sections).toHaveLength(0);
    expect(ctx._registeredTools.some((t) => t.name === 'recall')).toBe(true);
    const sessionListeners = ctx._onCallbacks.get('session/event');
    expect(sessionListeners).toBeUndefined(); // 不监听 session/event

    const nextCalled = await runPreStep(ctx, session);
    expect(nextCalled).toBe(true); // 阻塞执行后放行
    expect(calls.n).toBe(1);
    const req = ctx._subagentCalls[0]?.request as {
      persona?: string;
      prompt?: Array<{ type?: string; text?: string }>;
    };
    expect(req.persona).toBe(OBSERVER_PERSONA);

    const historyText = latestHistoryText(session);
    expect(historyText).toContain('user_message message_id:user-c-eval text:请帮我完成一个任务');
    expect(historyText).toContain(
      'toolcall message_id:result-c-eval purpose:跑一下 summary:产物符合预期；下一步提交',
    );
    // 遮蔽后表层 = <om-history> + 尾部 1 条
    expect(session.surface.nodes.length).toBe(2);
    const claimIdx = session.events.findIndex(
      (e) => (e as { type?: string }).type === 'compaction/prune',
    );
    const replaceIdx = session.events.findIndex(
      (e) =>
        e.type === 'user/message' &&
        typeof e.surfaceOp === 'object' &&
        e.surfaceOp !== null &&
        (e.surfaceOp as { op?: string }).op === 'replace',
    );
    expect(claimIdx).not.toBe(-1);
    expect(replaceIdx).toBe(claimIdx + 1);
    expect(session.surface.replaceGeneration).toBeGreaterThanOrEqual(1);
  });

  it('增量追加：旧摘要原文保留，新观察日志追加在末尾', async () => {
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
    const calls = { n: 0 };
    // window 11 + historyMergeRatio 1：观察阈值 5.5 ≤ 未压缩 6 tokens（触发）；
    // 反思阈值 11 > 旧摘要 10 tokens（不触发）——隔离观察路径验证增量追加
    const ctx = observeCtx('toolcall message_id:result-c1 summary:新内容', calls, 11);
    apply(ctx, { tailMessageCount: 1, historyMergeRatio: 1 });
    await runPreStep(ctx, session);
    const historyText = latestHistoryText(session);
    expect(historyText).toContain('旧任务'); // 旧摘要原文保留
    expect(historyText).toContain('新内容'); // 新观察日志追加
    const oldIdx = historyText.indexOf('旧任务');
    const newIdx = historyText.indexOf('新内容');
    expect(oldIdx).toBeGreaterThan(-1);
    expect(newIdx).toBeGreaterThan(oldIdx);
  });

  it('未达观察阈值不压缩（无 fork、无 <om-history>）', async () => {
    const session = makeSession({
      events: buildToolCallFlow({
        code: 'a()',
        description: '任务A',
        callId: 'c1',
        resultText: 'r1',
        withTurnEnd: true,
      }),
    });
    const ctx = makeCtx({ resolveModelInfo: async () => ({ context: { contextWindow: 100000 } }) });
    apply(ctx, {});
    await runPreStep(ctx, session);
    expect(ctx._subagentCalls).toHaveLength(0);
    expect(latestHistoryText(session)).toBe('');
    expect(session.surface.nodes.length).toBe(3);
  });

  it('fork 失败（无输出）不产生替换', async () => {
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
      resolveModelInfo: async () => ({ context: { contextWindow: 8 } }),
      subagentStart: async () => ({
        result: Promise.resolve({ output: [], stopReason: 'completed' }),
        dispose: async () => {},
      }),
    });
    apply(ctx, { tailMessageCount: 1 });
    await runPreStep(ctx, session);
    expect(ctx._subagentCalls).toHaveLength(1); // fork 被调用
    expect(session.events.some((e) => (e as { type?: string }).type === 'compaction/prune')).toBe(
      false,
    );
    expect(latestHistoryText(session)).toBe(''); // 无部分替换
  });

  it('中断标记（aborted）进入观察提示词', async () => {
    const flowEvents = buildToolCallFlow({
      code: 'a()',
      description: '任务A',
      callId: 'c1',
      resultText: 'r1',
      withTurnEnd: true,
      turnEndReason: { kind: 'aborted', reason: { kind: 'user' } },
    });
    const session = makeSession({ events: flowEvents });
    const calls = { n: 0 };
    const ctx = observeCtx('user_message message_id:user-c1 text:请帮我完成一个任务', calls);
    apply(ctx, { tailMessageCount: 1 });
    await runPreStep(ctx, session);
    const req = ctx._subagentCalls[0]?.request as {
      prompt?: Array<{ type?: string; text?: string }>;
    };
    const promptText = String(req.prompt?.[0]?.text ?? '');
    expect(promptText).toContain('[interrupted] turn 1 被中断（aborted，原因 user）');
  });

  it('当前 turn 消息不压缩：区间封顶后其消息留在表层', async () => {
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
    const calls = { n: 0 };
    const ctx = observeCtx('toolcall message_id:result-c1 summary:A', calls);
    apply(ctx, { tailMessageCount: 1 });
    await runPreStep(ctx, session);
    const nodes = session.surface.nodes;
    expect(nodes.length).toBe(4); // <om-history> + 5,6,8
    expect(nodes[1]).toBe(5);
    expect(nodes[2]).toBe(6);
    expect(nodes[3]).toBe(8);
    // 对照表只含被压缩的 0,1,3，不含当前 turn 消息
    const req = ctx._subagentCalls[0]?.request as {
      prompt?: Array<{ type?: string; text?: string }>;
    };
    const promptText = String(req.prompt?.[0]?.text ?? '');
    expect(promptText).toContain('message_id=user-c1');
    expect(promptText).not.toContain('message_id=user-c2');
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
    const ctx = makeCtx({ resolveModelInfo: async () => ({ context: { contextWindow: 8 } }) });
    apply(ctx, {});
    await runPreStep(ctx, session);
    expect(ctx._subagentCalls).toHaveLength(0);
    expect(session.surface.nodes.length).toBe(3);
  });
});

describe('apply 接线（OM 反思压缩）', () => {
  /** 运行 pre-step 监听器并返回 fork 调用记录。 */
  async function runPreStep(ctx: ReturnType<typeof makeCtx>, session: Session) {
    const preStepListeners = ctx._onCallbacks.get('agent/pre-step');
    await preStepListeners?.[0]?.(
      { agent: { session }, signal: new AbortController().signal },
      () => {},
    );
  }

  it('摘要超反思阈值：fork 精简合并并替换单个 <om-history> 节点', async () => {
    // 摘要 40 字符 ≈ 10 tokens；window 16 × 0.2 = 3.2 → 触发反思
    // 未压缩消息 ≈ 6 tokens < 16 × 0.5 = 8 → 观察不触发
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
    const calls = { n: 0 };
    const ctx = makeCtx({
      resolveModelInfo: async () => ({ context: { contextWindow: 16 } }),
      subagentStart: async () => {
        calls.n += 1;
        return {
          result: Promise.resolve({ output: [textBlock('REFLECTED')], stopReason: 'completed' }),
          dispose: async () => {},
        };
      },
    });
    apply(ctx, {});
    await runPreStep(ctx, session);
    expect(calls.n).toBe(1);
    const req = ctx._subagentCalls[0]?.request as { persona?: string };
    expect(req.persona).toBe(REFLECTOR_PERSONA);
    expect(session.surface.nodes.length).toBe(before); // 单节点替换，节点数不变
    expect(latestHistoryText(session)).toContain('REFLECTED');
    expect(latestHistoryText(session)).not.toContain('X'.repeat(40)); // 旧摘要被替换
  });

  it('先反思后观察串行：摘要先合并，新观察追加到合并结果', async () => {
    // window 8：反思阈值 1.6（摘要 10 tokens ✓），观察阈值 4（未压缩 6 tokens ✓）
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
    let n = 0;
    const ctx = makeCtx({
      resolveModelInfo: async () => ({ context: { contextWindow: 8 } }),
      subagentStart: async () => {
        n += 1;
        return {
          result: Promise.resolve({
            output: [textBlock(n === 1 ? 'REFLECTED' : 'OBSERVED')],
            stopReason: 'completed',
          }),
          dispose: async () => {},
        };
      },
    });
    apply(ctx, { tailMessageCount: 1 });
    await runPreStep(ctx, session);
    expect(ctx._subagentCalls).toHaveLength(2);
    const persona0 = (ctx._subagentCalls[0]?.request as { persona?: string } | undefined)?.persona;
    const persona1 = (ctx._subagentCalls[1]?.request as { persona?: string } | undefined)?.persona;
    expect(persona0).toBe(REFLECTOR_PERSONA); // 先反思
    expect(persona1).toBe(OBSERVER_PERSONA); // 后观察
    const text = latestHistoryText(session);
    expect(text.indexOf('REFLECTED')).toBeGreaterThan(-1);
    expect(text.indexOf('OBSERVED')).toBeGreaterThan(text.indexOf('REFLECTED'));
  });
});

describe('recall 工具', () => {
  it('start_id+end_id 返回区间内全部原始消息（含代码与结果）', async () => {
    const session = makeSession({ events: twoCallFlow() });
    const tool = buildRecallTool();
    const exec = { agent: { session } };
    const span = await tool.execute({ start_id: 'user-c1', end_id: 'result-c2' }, exec as never);
    expect(span).toContain('firstCode()');
    expect(span).toContain('secondCode()');
    expect(span).toContain('out1');
    expect(span).toContain('out2');
  });

  it('end_id 在 start_id 之前时仍输出两者间全部消息（顺序无关）', async () => {
    const session = makeSession({ events: twoCallFlow() });
    const tool = buildRecallTool();
    const exec = { agent: { session } };
    const span = await tool.execute({ start_id: 'result-c2', end_id: 'user-c1' }, exec as never);
    expect(span).toContain('firstCode()');
    expect(span).toContain('secondCode()');
    expect(span).toContain('out1');
    expect(span).toContain('out2');
  });

  it('offset 正数从 start_id 向后延伸', async () => {
    const session = makeSession({ events: twoCallFlow() });
    const tool = buildRecallTool();
    const exec = { agent: { session } };
    const span = await tool.execute({ start_id: 'assistant-c1', offset: 2 }, exec as never);
    expect(span).toContain('firstCode()');
    expect(span).toContain('out1');
    expect(span).toContain('请帮我完成一个任务');
    expect(span).not.toContain('secondCode()');
  });

  it('offset 负数从 start_id 向前延伸', async () => {
    const session = makeSession({ events: twoCallFlow() });
    const tool = buildRecallTool();
    const exec = { agent: { session } };
    const span = await tool.execute({ start_id: 'result-c2', offset: -3 }, exec as never);
    expect(span).toContain('out1');
    expect(span).toContain('secondCode()');
    expect(span).toContain('out2');
    expect(span).not.toContain('firstCode()');
  });

  it('offset 非整数自动向下取整（正负都取 floor）', async () => {
    const session = makeSession({ events: twoCallFlow() });
    const tool = buildRecallTool();
    const exec = { agent: { session } };
    const up = await tool.execute({ start_id: 'assistant-c1', offset: 2.9 }, exec as never);
    expect(up).toContain('out1');
    expect(up).not.toContain('secondCode()');
    const down = await tool.execute({ start_id: 'result-c2', offset: -1.5 }, exec as never);
    expect(down).toContain('secondCode()');
    expect(down).toContain('out2');
    expect(down).not.toContain('out1');
    const zero = await tool.execute({ start_id: 'result-c2', offset: 0 }, exec as never);
    expect(zero).toContain('out2');
    expect(zero).not.toContain('secondCode()');
    expect(zero).not.toContain('out1');
  });

  it('end_id 与 offset 同时给出时 end_id 优先', async () => {
    const session = makeSession({ events: twoCallFlow() });
    const tool = buildRecallTool();
    const exec = { agent: { session } };
    const span = await tool.execute(
      { start_id: 'user-c1', end_id: 'result-c2', offset: 0 },
      exec as never,
    );
    expect(span).toContain('secondCode()');
    expect(span).toContain('out2');
  });

  it('end_id 与 offset 都缺省时抛错', async () => {
    const session = makeSession({ events: twoCallFlow() });
    const tool = buildRecallTool();
    const exec = { agent: { session } };
    await expect(tool.execute({ start_id: 'user-c1' }, exec as never)).rejects.toThrow(
      /至少提供一个/,
    );
  });

  it('未知 message_id 返回提示', async () => {
    const session = makeSession({ events: twoCallFlow() });
    const tool = buildRecallTool();
    const exec = { agent: { session } };
    const badStart = await tool.execute({ start_id: 'nope', offset: 1 }, exec as never);
    expect(String(badStart)).toContain('start_id "nope" 不存在');
    const badEnd = await tool.execute({ start_id: 'user-c1', end_id: 'nope2' }, exec as never);
    expect(String(badEnd)).toContain('end_id "nope2" 不存在');
  });

  it('execute 缺 start_id 抛错', async () => {
    const session = makeSession({ events: twoCallFlow() });
    const tool = buildRecallTool();
    const exec = { agent: { session } };
    await expect(tool.execute({ offset: 1 }, exec as never)).rejects.toThrow(/start_id/);
    await expect(tool.execute({}, exec as never)).rejects.toThrow(/start_id/);
  });

  it('execute offset 类型非法时抛错', async () => {
    const session = makeSession({ events: twoCallFlow() });
    const tool = buildRecallTool();
    const exec = { agent: { session } };
    await expect(tool.execute({ start_id: 'user-c1', offset: '2' }, exec as never)).rejects.toThrow(
      /offset/,
    );
  });

  it('tool-result-pruner 控制超大工具结果的输出（recall 不截断）', async () => {
    const flow = buildToolCallFlow({
      code: 'big()',
      description: '大结果',
      callId: 'cb',
      resultText: 'X'.repeat(20000),
    });
    const session = makeSession({ events: flow });
    const prunedBlocks = [
      {
        type: 'tool-result',
        toolCallId: 'cb',
        isError: false,
        content: [{ type: 'text', text: 'PRUNED-HEAD ... PRUNED-TAIL' }],
      },
    ];
    const tool = buildRecallTool(() => ({
      pruneContent: (blocks: unknown[]) => {
        const text = (
          blocks as Array<{
            type?: string;
            text?: string;
            content?: Array<{ type?: string; text?: string }>;
          }>
        )
          .map((b) => {
            if (b.type === 'text') return b.text ?? '';
            if (b.type === 'tool-result')
              return (b.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('');
            return '';
          })
          .join('');
        return text.length > 10 ? prunedBlocks : null;
      },
    }));
    const exec = { agent: { session } };
    const span = await tool.execute({ start_id: 'result-cb', offset: 0 }, exec as never);
    expect(String(span)).toContain('PRUNED-HEAD');
    expect(String(span)).not.toContain('X'.repeat(20000));
    const raw = await buildRecallTool().execute(
      { start_id: 'result-cb', offset: 0 },
      exec as never,
    );
    expect(String(raw)).toContain('X'.repeat(20000));
  });

  it('subagent 会话调用被拒绝', async () => {
    const flow = buildToolCallFlow({
      code: 'a()',
      description: 'x',
      callId: 'c1',
      resultText: 'r1',
    });
    const session = makeSession({ events: flow, header: { origin: 'subagent' } });
    const tool = buildRecallTool();
    const result = await tool.execute({ start_id: 'user-c1', offset: 1 }, {
      agent: { session },
    } as never);
    expect(String(result)).toContain('仅主会话可用');
  });
});

describe('recall 参数校验（zod schema）', () => {
  it('合法参数通过解析（start_id 必填，end_id/offset 至少其一，可同时给出）', () => {
    expect(parseRecallArgs({ start_id: 'a', offset: 2 })).toEqual({ start_id: 'a', offset: 2 });
    expect(parseRecallArgs({ start_id: 'a', end_id: 'b' })).toEqual({ start_id: 'a', end_id: 'b' });
    expect(parseRecallArgs({ start_id: 'a', end_id: 'b', offset: 0 })).toEqual({
      start_id: 'a',
      end_id: 'b',
      offset: 0,
    });
  });

  it('缺 start_id 抛错并指出字段', () => {
    expect(() => parseRecallArgs({ offset: 1 })).toThrow(/start_id/);
    expect(() => parseRecallArgs({ end_id: 'b' })).toThrow(/start_id/);
  });

  it('空字符串 id 不抛错（由 execute 走「不存在」提示）', () => {
    expect(parseRecallArgs({ start_id: '', offset: 1 })).toEqual({ start_id: '', offset: 1 });
    expect(parseRecallArgs({ start_id: 'a', end_id: '' })).toEqual({ start_id: 'a', end_id: '' });
  });

  it('offset 必须为 number', () => {
    expect(() => parseRecallArgs({ start_id: 'a', offset: '2' })).toThrow(/offset/);
    expect(() => parseRecallArgs({ start_id: 'a', offset: null })).toThrow(/offset/);
  });

  it('未知键被剥离', () => {
    expect(parseRecallArgs({ start_id: 'a', offset: 1, junk: true })).toEqual({
      start_id: 'a',
      offset: 1,
    });
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
