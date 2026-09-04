// compress.ts 单元测试：token 估算 estimateTextTokens、观察触发净压力口径
// （上下文压力 − 已压缩块 − 系统提示词 − 工具定义，经 apply 接线验证）、
// 压缩区间 computeCompressRange、配对平衡 isPairBalancedAfter、压缩边界 historySection。
import { describe, expect, it, vi } from 'vitest';

// 隔离 apply 的模型下载编排：ensureModelReady 打桩为"就绪"，避免单测触发真实下载/网络
vi.mock('../src/embedding.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/embedding.ts')>();
  return {
    ...actual,
    ensureModelReady: vi.fn(async () => 'ready' as const),
  };
});

import {
  computeCompressRange,
  estimateTextTokens,
  historySection,
  isPairBalancedAfter,
} from '../src/compress.ts';
import { HISTORY_TAG, HISTORY_TIP, PLUGIN_LABEL } from '../src/constants.ts';
import { apply } from '../src/index.ts';
import type { Session, SessionEvent } from '../src/types.ts';
import {
  buildToolCallFlow,
  historyMessage,
  makeCtx,
  makeMessage,
  makeSession,
  textBlock,
} from './helpers.ts';

describe('token 估算 estimateTextTokens', () => {
  it('4 字符 ≈ 1 token（与宿主启发式一致）', () => {
    expect(estimateTextTokens('')).toBe(0);
    expect(estimateTextTokens('abcd')).toBe(1);
    expect(estimateTextTokens('abcde')).toBe(2);
    expect(estimateTextTokens('abcdefgh')).toBe(2);
  });
});

describe('观察触发：净压力口径（上下文压力 − 已压缩块 − 系统提示词 − 工具定义，ctx.tokenMeter.measure）', () => {
  /** 运行 pre-step 监听器。 */
  async function runPreStep(ctx: ReturnType<typeof makeCtx>, session: Session) {
    const listeners = ctx._onCallbacks.get('agent/pre-step');
    await listeners?.[0]?.({ agent: { session }, signal: new AbortController().signal }, () => {});
  }

  /** 固定观察报告（覆盖夹具完整消息 index 区间）。 */
  const observeReport = [
    '<history>',
    '<user_message index="0">ok</user_message>',
    '<assistant start="1" end="2">toolcall index:2 purpose:任务A summary:完成</assistant>',
    '</history>',
  ].join('\n');

  it('压力取 measure().totalTokens：真实 usage 远大于表层启发式时也触发', async () => {
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
      llmStream: [{ type: 'text-delta', text: observeReport }],
    });
    apply(ctx, { observeThresholdTokens: 100000, tailMessageCount: 0 });
    await runPreStep(ctx, session);
    // 表层启发式远小于阈值，但注入的真实压力 500000 ≥ 100000 → 触发观察压缩
    expect(ctx._llmCalls).toHaveLength(1);
  });

  it('压力低于阈值跳过（日志说明上下文压力）', async () => {
    const session = makeSession({
      events: buildToolCallFlow({
        code: 'a()',
        description: '任务A',
        callId: 'c1',
        resultText: 'r1',
        withTurnEnd: true,
      }),
    });
    const ctx = makeCtx({ meterTotalTokens: 50 });
    apply(ctx, { observeThresholdTokens: 100000 });
    await runPreStep(ctx, session);
    expect(ctx._llmCalls).toHaveLength(0);
    const steps = ctx._loggerCalls.filter((c) => c.level === 'debug').map((c) => String(c.args[0]));
    expect(
      steps.some((s) =>
        s.includes(
          '净压力 50 tokens（上下文压力 50 − 已压缩块 0 − 系统提示词 0 − 工具定义 0）< 阈值 100000',
        ),
      ),
    ).toBe(true);
  });

  it('meter 未注入真实 usage 时回退表层启发式（totalTokens = surfaceTokens）', async () => {
    const session = makeSession({
      events: buildToolCallFlow({
        code: 'a()',
        description: '任务A',
        callId: 'c1',
        resultText: 'r1',
        withTurnEnd: true,
      }),
    });
    const ctx = makeCtx({ llmStream: [{ type: 'text-delta', text: observeReport }] });
    apply(ctx, { observeThresholdTokens: 1, tailMessageCount: 0 });
    await runPreStep(ctx, session);
    expect(ctx._llmCalls).toHaveLength(1);
  });

  it('已压缩块 token 从压力中扣除：净压力低于阈值跳过', async () => {
    const inner = '旧摘要内容'.repeat(100);
    const session = makeSession({
      events: [
        historyMessage(inner),
        ...buildToolCallFlow({
          code: 'a()',
          description: '任务A',
          callId: 'c1',
          resultText: 'r1',
          withTurnEnd: true,
        }),
      ],
    });
    // 与 historyMessage 同构的完整块文本（含 tip 开/闭标签），据此精确计算已压缩块 token
    const historyTokens = estimateTextTokens(
      `<history tip="${HISTORY_TIP}">\n${inner}\n</history>`,
    );
    // 注入压力 = 阈值 + 历史块 tokens − 1 → 净压力恰低于阈值 1 token
    const pressure = 100000 + historyTokens - 1;
    const ctx = makeCtx({ meterTotalTokens: pressure });
    apply(ctx, { observeThresholdTokens: 100000, tailMessageCount: 0 });
    await runPreStep(ctx, session);
    expect(ctx._llmCalls).toHaveLength(0);
    const steps = ctx._loggerCalls.filter((c) => c.level === 'debug').map((c) => String(c.args[0]));
    expect(
      steps.some((s) =>
        s.includes(
          `净压力 ${pressure - historyTokens} tokens（上下文压力 ${pressure} − 已压缩块 ${historyTokens} − 系统提示词 0 − 工具定义 0）< 阈值 100000`,
        ),
      ),
    ).toBe(true);
  });

  it('系统提示词 token 从净压力扣除：低于阈值跳过', async () => {
    const session = makeSession({
      events: buildToolCallFlow({
        code: 'a()',
        description: '任务A',
        callId: 'c1',
        resultText: 'r1',
        withTurnEnd: true,
      }),
    });
    const sysText = 'S'.repeat(40); // 长度/4 → 10 tokens
    const pressure = 100000 + 10 - 1; // 扣除系统提示词后恰好低于阈值 1 token
    const ctx = makeCtx({
      meterTotalTokens: pressure,
      systemPromptAssemble: async () => ({
        sections: [{ name: 'stub', text: sysText }],
        contexts: [],
        tools: [],
        variables: {},
      }),
    });
    apply(ctx, { observeThresholdTokens: 100000, tailMessageCount: 0 });
    await runPreStep(ctx, session);
    expect(ctx._llmCalls).toHaveLength(0);
    expect(ctx._assembleCalls).toHaveLength(1);
    const steps = ctx._loggerCalls.filter((c) => c.level === 'debug').map((c) => String(c.args[0]));
    expect(
      steps.some((s) =>
        s.includes(
          `净压力 ${pressure - 10} tokens（上下文压力 ${pressure} − 已压缩块 0 − 系统提示词 10 − 工具定义 0）< 阈值 100000`,
        ),
      ),
    ).toBe(true);
  });

  it('系统提示词 token 从净压力扣除：扣除后仍达阈值则触发（assemble 收到 agent 与 signal）', async () => {
    const session = makeSession({
      events: buildToolCallFlow({
        code: 'a()',
        description: '任务A',
        callId: 'c1',
        resultText: 'r1',
        withTurnEnd: true,
      }),
    });
    const sysText = 'S'.repeat(40); // 长度/4 → 10 tokens
    const pressure = 100000 + 10; // 扣除系统提示词后恰好达到阈值
    const ctx = makeCtx({
      meterTotalTokens: pressure,
      llmStream: [{ type: 'text-delta', text: observeReport }],
      systemPromptAssemble: async () => ({
        sections: [{ name: 'stub', text: sysText }],
        contexts: [],
        tools: [],
        variables: {},
      }),
    });
    apply(ctx, { observeThresholdTokens: 100000, tailMessageCount: 0 });
    await runPreStep(ctx, session);
    expect(ctx._llmCalls).toHaveLength(1);
    expect(ctx._assembleCalls).toHaveLength(1);
    const call = ctx._assembleCalls[0] as { agent?: { session?: unknown }; signal?: unknown };
    expect(call.agent?.session).toBe(session);
    expect(call.signal).toBeInstanceOf(AbortSignal);
  });

  it('systemPrompt.assemble 失败按 0 计（warn 日志，不影响观察判定）', async () => {
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
      meterTotalTokens: 99999,
      systemPromptAssemble: async () => {
        throw new Error('boom');
      },
    });
    apply(ctx, { observeThresholdTokens: 100000, tailMessageCount: 0 });
    await runPreStep(ctx, session);
    expect(ctx._llmCalls).toHaveLength(0);
    const warns = ctx._loggerCalls.filter((c) => c.level === 'warn').map((c) => String(c.args[0]));
    expect(warns.some((s) => s.includes('系统提示词 tokens 估算失败，按 0 计: boom'))).toBe(true);
    const steps = ctx._loggerCalls.filter((c) => c.level === 'debug').map((c) => String(c.args[0]));
    expect(steps.some((s) => s.includes('− 系统提示词 0 − 工具定义 0）< 阈值 100000'))).toBe(true);
  });

  it('工具定义 token 从净压力扣除：低于阈值跳过', async () => {
    const session = makeSession({
      events: buildToolCallFlow({
        code: 'a()',
        description: '任务A',
        callId: 'c1',
        resultText: 'r1',
        withTurnEnd: true,
      }),
      requestHeaderValue: {
        config: { provider: 'test', model: 'test-model' },
        tools: [
          { name: 'run_code', description: '执行代码', schema: { type: 'object' } },
          { name: 'recall', description: '回看会话', schema: { type: 'object' } },
        ],
      },
    });
    const header = session.requestHeader() as { tools?: unknown[] };
    const toolsTokens = estimateTextTokens(JSON.stringify(header.tools));
    // 注入压力 = 阈值 + 工具定义 tokens − 1 → 扣除后净压力恰低于阈值 1 token
    const pressure = 100000 + toolsTokens - 1;
    const ctx = makeCtx({ meterTotalTokens: pressure });
    apply(ctx, { observeThresholdTokens: 100000, tailMessageCount: 0 });
    await runPreStep(ctx, session);
    expect(ctx._llmCalls).toHaveLength(0);
    const steps = ctx._loggerCalls.filter((c) => c.level === 'debug').map((c) => String(c.args[0]));
    expect(
      steps.some((s) =>
        s.includes(
          `净压力 ${pressure - toolsTokens} tokens（上下文压力 ${pressure} − 已压缩块 0 − 系统提示词 0 − 工具定义 ${toolsTokens}）< 阈值 100000`,
        ),
      ),
    ).toBe(true);
  });

  it('工具定义 token 从净压力扣除：扣除后仍达阈值则触发', async () => {
    const session = makeSession({
      events: buildToolCallFlow({
        code: 'a()',
        description: '任务A',
        callId: 'c1',
        resultText: 'r1',
        withTurnEnd: true,
      }),
      requestHeaderValue: {
        config: { provider: 'test', model: 'test-model' },
        tools: [{ name: 'run_code', description: '执行代码', schema: { type: 'object' } }],
      },
    });
    const header = session.requestHeader() as { tools?: unknown[] };
    const toolsTokens = estimateTextTokens(JSON.stringify(header.tools));
    // 注入压力 = 阈值 + 工具定义 tokens → 扣除后净压力恰达阈值（触发）
    const pressure = 100000 + toolsTokens;
    const ctx = makeCtx({
      meterTotalTokens: pressure,
      llmStream: [{ type: 'text-delta', text: observeReport }],
    });
    apply(ctx, { observeThresholdTokens: 100000, tailMessageCount: 0 });
    await runPreStep(ctx, session);
    expect(ctx._llmCalls).toHaveLength(1);
  });

  it('已压缩块 token 从压力中扣除：扣除后净压力仍达阈值则触发', async () => {
    const inner = '旧摘要内容'.repeat(100);
    const session = makeSession({
      events: [
        historyMessage(inner),
        ...buildToolCallFlow({
          code: 'a()',
          description: '任务A',
          callId: 'c1',
          resultText: 'r1',
          withTurnEnd: true,
        }),
      ],
    });
    const historyTokens = estimateTextTokens(
      `<history tip="${HISTORY_TIP}">\n${inner}\n</history>`,
    );
    // 注入压力 = 阈值 + 历史块 tokens → 净压力恰达阈值（触发）
    const ctx = makeCtx({
      meterTotalTokens: 100000 + historyTokens,
      llmStream: [{ type: 'text-delta', text: observeReport }],
    });
    apply(ctx, { observeThresholdTokens: 100000, tailMessageCount: 0 });
    await runPreStep(ctx, session);
    expect(ctx._llmCalls).toHaveLength(1);
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

  it('尾部保留 tailCount 条，其余压缩（区间终点回退到配对平衡点）', () => {
    const session = makeSession({ events: singleFlow() });
    // tailCount=1：表层 [0,1,3]，endIdx=1 落在 assistant(tool-call) 上 → 回退到 0
    expect(computeCompressRange(session, 1)).toEqual({
      start: 0,
      end: 0,
      shadowedSeqs: [0],
    });
    // tailCount=0：压缩全部（result 之后平衡）
    expect(computeCompressRange(session, 0)).toEqual({
      start: 0,
      end: 3,
      shadowedSeqs: [0, 1, 3],
    });
  });

  it('当前 turn 消息可压缩（mid-turn：区间延伸到当前 turn 已完备的消息）', () => {
    // 第二个流程没有 turn/end：模拟当前 turn 进行中，pre-step 时 call-result 已完备
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
    // tailCount=1：endIdx=4 落在 assistant-c2(tool-call) 上 → 回退到 3（user-c2，平衡）
    expect(computeCompressRange(session, 1)).toEqual({
      start: 0,
      end: 5,
      shadowedSeqs: [0, 1, 3, 5],
    });
  });

  it('无 turn/end 时仍可压缩（pre-step call-result 完备，不依赖 turn 边界）', () => {
    const flow = buildToolCallFlow({
      code: 'a()',
      description: '任务A',
      callId: 'c1',
      resultText: 'r1',
    });
    // 表层 [0,1,3]；tailCount=1 → 回退到 0
    expect(computeCompressRange(makeSession({ events: flow }), 1)).toEqual({
      start: 0,
      end: 0,
      shadowedSeqs: [0],
    });
  });

  it('尾部条数 ≥ 表层节点数时返回 undefined', () => {
    expect(computeCompressRange(makeSession({ events: singleFlow() }), 5)).toBeUndefined();
  });

  it('空表层返回 undefined', () => {
    expect(computeCompressRange(makeSession(), 1)).toBeUndefined();
  });
});

describe('配对平衡 isPairBalancedAfter', () => {
  it('助手 tool-call 与其结果之间不平衡，结果之后平衡', () => {
    const flow = buildToolCallFlow({
      code: 'a()',
      description: '任务A',
      callId: 'c1',
      resultText: 'r1',
    });
    const session = makeSession({ events: flow }); // 表层 [0,1,3]
    expect(isPairBalancedAfter(session, 0)).toBe(true); // user 之后
    expect(isPairBalancedAfter(session, 1)).toBe(false); // assistant(tool-call) 之后
    expect(isPairBalancedAfter(session, 3)).toBe(true); // tool/result 之后
  });

  it('无工具调用的消息边界平衡', () => {
    const session = makeSession({
      events: [
        {
          type: 'user/message',
          data: makeMessage({ content: [textBlock('你好')], id: 'u1' }),
        } as unknown as SessionEvent,
      ],
    });
    expect(isPairBalancedAfter(session, 0)).toBe(true);
  });
});

describe('压缩边界 historySection', () => {
  it('收集全部 <history> 块（含 tip 属性）并以最后一个块为边界', () => {
    const session = makeSession({
      events: [historyMessage('块1'), historyMessage('块2', 'history-2')],
    });
    const { blocks, boundarySeq } = historySection(session);
    expect(blocks.map((b) => b.seq)).toEqual([0, 1]);
    expect(boundarySeq).toBe(1);
    expect(blocks[0]?.text).toContain('块1');
    expect(blocks[1]?.text).toContain('块2');
    expect(blocks[0]?.text.startsWith(`<${HISTORY_TAG} tip="${HISTORY_TIP}">`)).toBe(true);
  });

  it('扫描全部表层节点：最后一个 history 块之后的普通消息为未压缩，其前（含自身）为已压缩', () => {
    const session = makeSession({
      events: [
        historyMessage('旧任务'),
        ...buildToolCallFlow({ code: 'a()', description: '任务A', callId: 'c1', resultText: 'r1' }),
        historyMessage('新任务', 'history-msg-2'),
      ],
    });
    const { blocks, boundarySeq } = historySection(session);
    expect(blocks.map((b) => b.seq)).toEqual([0, 5]); // 全部 history 块（含分散在普通消息之后的）
    expect(boundarySeq).toBe(5);
  });

  it('无压缩日志时 blocks 为空、boundarySeq 为 undefined', () => {
    const empty = historySection(makeSession());
    expect(empty.blocks).toEqual([]);
    expect(empty.boundarySeq).toBeUndefined();
    const flowOnly = historySection(
      makeSession({
        events: buildToolCallFlow({
          code: 'a()',
          description: '任务A',
          callId: 'c1',
          resultText: 'r1',
        }),
      }),
    );
    expect(flowOnly.blocks).toEqual([]);
    expect(flowOnly.boundarySeq).toBeUndefined();
  });

  it('D：旧格式 <om-history> 块（无 <history> 标签）不识别为压缩日志（干净切换）', () => {
    // 旧版本消息为前缀句 + <om-history> 块；新格式只认 <history> 开标签 → 视为普通消息
    const session = makeSession({
      events: [
        {
          type: 'user/message',
          data: makeMessage({
            content: [
              textBlock(
                '以下是过往会话的压缩日志（<om-history>），为已确立背景：直接继续，不要复述。\n\n<om-history>\n旧任务内容\n</om-history>',
              ),
            ],
            source: { kind: 'plugin', plugin: 'compact', compactionId: 'legacy-1' },
            id: 'legacy-history',
          }),
        } as unknown as SessionEvent,
      ],
    });
    const { blocks, boundarySeq } = historySection(session);
    expect(blocks).toEqual([]);
    expect(boundarySeq).toBeUndefined();
  });

  it('D：不通过文本含标签判定摘要——普通用户消息即使含 <history> 文本也不算', () => {
    // 普通用户消息（非插件 source）文本里恰好含标签，不应被识别为压缩日志
    const session = makeSession({
      events: [
        {
          type: 'user/message',
          data: makeMessage({
            content: [textBlock('请解释一下 <history> 标签的含义')],
            id: 'user-fake',
          }),
        } as unknown as SessionEvent,
        historyMessage('真正的旧任务', 'history-real'),
      ],
    });
    expect(historySection(session).blocks.map((b) => b.seq)).toEqual([1]); // 仅真实 history 块，不含普通消息
    // 插件 source 但无 <history> 开标签的消息同样不识别
    const pluginNoTag = makeSession({
      events: [
        {
          type: 'user/message',
          data: makeMessage({
            content: [textBlock('运行时上下文快照')],
            source: { kind: 'plugin', plugin: PLUGIN_LABEL },
            id: 'snap',
          }),
        } as unknown as SessionEvent,
      ],
    });
    expect(historySection(pluginNoTag).blocks).toEqual([]);
    expect(historySection(pluginNoTag).boundarySeq).toBeUndefined();
  });
});
