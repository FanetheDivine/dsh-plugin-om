// dsh-plugin-om 单元测试（vitest）：配置校验 / 消息索引 /
// OM 两级压缩（观察/反思 fork 摘要）/ recall（范围+拒绝+参数校验）/ apply 接线。
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
  extractHistoryText,
  findLatestHistory,
  isPairBalancedAfter,
  measureUncompressedTokens,
  scanInterruptions,
} from '../src/compress.ts';
import { resolveConfig, resolveSummaryMode } from '../src/config.ts';
import { HISTORY_TAG, PLUGIN_LABEL } from '../src/constants.ts';
import { cosineSimilarity, ensureModelReady } from '../src/embedding.ts';
import { apply, inject, name } from '../src/index.ts';
import {
  indexCompleteMessages,
  indexMessages,
  messageIdOfEvent,
  renderCompleteMessage,
} from '../src/log-index.ts';
import { buildRecallTool, parseRecallArgs } from '../src/recall.ts';
import {
  buildSemanticRecallTool,
  matchExplanation,
  parseSemanticRecallArgs,
  resolveSemanticRange,
} from '../src/semantic-recall.ts';
import {
  buildObservePrompt,
  buildReflectPrompt,
  extractSummaryLog,
  HISTORY_FORMAT_NOTE,
  MIN_HISTORY_LENGTH,
  OBSERVER_PERSONA,
  REFLECTOR_PERSONA,
  renderMessages,
} from '../src/summarize.ts';
import type { Session, SessionEvent } from '../src/types.ts';
import {
  buildToolCallFlow,
  makeCtx,
  makeMessage,
  makeMeter,
  makeSession,
  textBlock,
  toolCallBlock,
  toolResultBlock,
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

/** 定位一次压缩的 compaction 生命周期事件下标（start/summary/替换消息/end；缺省 -1）。 */
function compactionLifecycle(session: Session) {
  const events = session.events;
  return {
    start: events.findIndex((e) => e.type === 'compaction/start'),
    summary: events.findIndex((e) => e.type === 'compaction/summary'),
    end: events.findIndex((e) => e.type === 'compaction/end'),
    replace: events.findIndex(
      (e) =>
        e.type === 'user/message' &&
        typeof e.surfaceOp === 'object' &&
        e.surfaceOp !== null &&
        (e.surfaceOp as { op?: string }).op === 'replace',
    ),
  };
}

/** 提取 <om-history> 替换消息的 source（checkpoint 标记断言用）。 */
function checkpointSourceOf(event: SessionEvent | undefined) {
  if (event?.type !== 'user/message') return undefined;
  return event.data.source as { kind?: string; plugin?: string; compactionId?: string } | undefined;
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
    expect(d.summaryMode).toBe('fork');
    expect(d.debug).toBe(process.env.NODE_ENV !== 'production'); // 缺省按 NODE_ENV 判定
    expect(d.recallEnabled).toBe(true);
    expect(d.semanticRecallEnabled).toBe(true);
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

  it('tailMessageCount 校验：默认 10，任意数值可覆盖（不做区间限制），非整数抛错', () => {
    expect(resolveConfig({}).tailMessageCount).toBe(10);
    expect(resolveConfig({ tailMessageCount: 3 }).tailMessageCount).toBe(3);
    expect(resolveConfig({ tailMessageCount: 0 }).tailMessageCount).toBe(0); // 无区间限制
    expect(() => resolveConfig({ tailMessageCount: 2.5 })).toThrow(); // 仍校验整数
  });

  it('整份配置留空（undefined/null/空串/空白串）时全部用默认值', () => {
    const empty = [undefined, null, '', '   '];
    for (const raw of empty) {
      const d = resolveConfig(raw);
      expect(d.thresholdRatio).toBe(0.5);
      expect(d.historyMergeRatio).toBe(0.2);
      expect(d.compressMaxTokens).toBe(4096);
      expect(d.tailMessageCount).toBe(10);
      expect(d.summaryMode).toBe('fork');
      expect(d.recallEnabled).toBe(true);
      expect(d.semanticRecallEnabled).toBe(true);
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

  it('未知键抛错；数值键不做区间限制（越界值按原样接受）', () => {
    expect(() => resolveConfig([])).toThrow(); // 空数组不是对象
    expect(() => resolveConfig('0.5')).toThrow(); // 非空字符串不是对象
    expect(() => resolveConfig({ badKey: 1 })).toThrow();
    // 阈值不再校验 0.01-1 区间：任意数值（调试场景）按原样接受
    expect(resolveConfig({ thresholdRatio: 2 }).thresholdRatio).toBe(2);
    expect(resolveConfig({ historyMergeRatio: 0 }).historyMergeRatio).toBe(0);
    expect(resolveConfig({ historyMergeRatio: 2 }).historyMergeRatio).toBe(2);
    expect(resolveConfig({ compressMaxTokens: 0 }).compressMaxTokens).toBe(0);
    expect(() => resolveConfig({ thresholdRatio: '0.5' })).toThrow(); // 非数值仍抛错
    expect(() => resolveConfig({ summaryMaxChars: 100 })).toThrow();
    expect(() => resolveConfig({ recallMaxMessages: 10 })).toThrow();
    expect(() => resolveConfig({ tailMessageBudget: 50 })).toThrow();
    expect(() => resolveConfig({ tailTokenBudgetRatio: 0.1 })).toThrow();
    expect(() => resolveConfig({ auto: false })).toThrow();
    expect(() => resolveConfig({ evalEnabled: false })).toThrow();
    expect(() => resolveConfig({ envDebug: true })).toThrow(); // 环境变量名不再是配置键
  });
});

describe('debug 配置键', () => {
  it('缺省：按 NODE_ENV !== production 判定（dev/test 输出，production 隐藏）', () => {
    const prev = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      expect(resolveConfig({}).debug).toBe(false);
      process.env.NODE_ENV = 'test';
      expect(resolveConfig({}).debug).toBe(true);
      delete process.env.NODE_ENV;
      expect(resolveConfig({}).debug).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });

  it('true 强制开启（含 production）、false 强制关闭（含 dev）', () => {
    const prev = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      expect(resolveConfig({ debug: true }).debug).toBe(true);
      process.env.NODE_ENV = 'test';
      expect(resolveConfig({ debug: false }).debug).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });

  it('非 boolean 值抛错；留空回退默认', () => {
    expect(() => resolveConfig({ debug: 'true' })).toThrow(/debug/);
    expect(() => resolveConfig({ debug: 1 })).toThrow(/debug/);
    expect(resolveConfig({ debug: null }).debug).toBe(process.env.NODE_ENV !== 'production');
    expect(resolveConfig({ debug: '' }).debug).toBe(process.env.NODE_ENV !== 'production');
  });
});

describe('摘要模式 resolveSummaryMode / summaryMode 配置键', () => {
  it('缺省 / null / 空串 / fork 回退 fork', () => {
    expect(resolveSummaryMode(undefined)).toBe('fork');
    expect(resolveSummaryMode(null)).toBe('fork');
    expect(resolveSummaryMode('')).toBe('fork');
    expect(resolveSummaryMode('   ')).toBe('fork');
    expect(resolveSummaryMode('fork')).toBe('fork');
    expect(resolveConfig({}).summaryMode).toBe('fork');
    expect(resolveConfig({ summaryMode: null }).summaryMode).toBe('fork');
    expect(resolveConfig({ summaryMode: '' }).summaryMode).toBe('fork');
  });

  it("'new' 切换 new 模式、'disable' 关闭自动压缩（config 键）", () => {
    expect(resolveSummaryMode('new')).toBe('new');
    expect(resolveSummaryMode('disable')).toBe('disable');
    expect(resolveConfig({ summaryMode: 'new' }).summaryMode).toBe('new');
    expect(resolveConfig({ summaryMode: 'disable' }).summaryMode).toBe('disable');
  });

  it('非法值抛错并指出配置键', () => {
    expect(() => resolveSummaryMode('bogus')).toThrow(/summaryMode/);
    expect(() => resolveConfig({ summaryMode: 'bogus' })).toThrow(/summaryMode/);
  });
});

describe('recallEnabled / semanticRecallEnabled 配置键', () => {
  it('缺省启用（true）；false 禁用；留空回退默认', () => {
    expect(resolveConfig({}).recallEnabled).toBe(true);
    expect(resolveConfig({}).semanticRecallEnabled).toBe(true);
    expect(resolveConfig({ recallEnabled: false }).recallEnabled).toBe(false);
    expect(resolveConfig({ semanticRecallEnabled: false }).semanticRecallEnabled).toBe(false);
    expect(resolveConfig({ recallEnabled: null }).recallEnabled).toBe(true);
    expect(resolveConfig({ semanticRecallEnabled: '' }).semanticRecallEnabled).toBe(true);
  });

  it('非 boolean 值抛错', () => {
    expect(() => resolveConfig({ recallEnabled: 'false' })).toThrow(/recallEnabled/);
    expect(() => resolveConfig({ semanticRecallEnabled: 0 })).toThrow(/semanticRecallEnabled/);
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

describe('完整消息索引 indexCompleteMessages', () => {
  it('三类折叠：用户消息 / AI 文本 / 每 tool-call+result 一条（文本与调用拆开）', () => {
    const session = makeSession({ events: twoCallFlow() });
    const cms = indexCompleteMessages(session);
    expect(cms.map((c) => [c.index, c.type])).toEqual([
      [0, 'user'],
      [1, 'assistant'],
      [2, 'toolcall'],
      [3, 'user'],
      [4, 'assistant'],
      [5, 'toolcall'],
    ]);
    expect(cms[2]?.callId).toBe('c1');
    expect(cms[2]?.seqs).toEqual([1, 3]); // assistant-c1 + result-c1
    expect(cms[5]?.callId).toBe('c2');
    expect(cms[5]?.seqs).toEqual([5, 7]); // assistant-c2 + result-c2（tool/call 为日志事件不入索引）
  });

  it('插件自产 user 消息不占位（<om-history> 与运行时快照）', () => {
    const session = makeSession({
      events: [
        historyMessage('旧任务'),
        ...twoCallFlow(),
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
    const cms = indexCompleteMessages(session);
    expect(cms).toHaveLength(6); // 仅两条流程的 6 条完整消息
    expect(cms[0]?.type).toBe('user');
  });

  it('未匹配的 result 独立成条（防御）', () => {
    const events = [
      {
        type: 'tool/result',
        data: {
          turn: 1,
          step: 1,
          message: makeMessage({
            role: 'user',
            content: [toolResultBlock('ghost', [textBlock('r')])],
            source: { kind: 'tool', callId: 'ghost' },
            id: 'r-ghost',
          }),
        },
      } as unknown as SessionEvent,
    ];
    const cms = indexCompleteMessages(makeSession({ events }));
    expect(cms).toHaveLength(1);
    expect(cms[0]?.type).toBe('toolcall');
    expect(cms[0]?.seqs).toEqual([0]);
  });

  it('同一 assistant 消息含文本 + 多个 tool-call：文本 1 条 + 每调用 1 条', () => {
    const events = [
      {
        type: 'user/message',
        data: makeMessage({ content: [textBlock('hi')], id: 'u' }),
      },
      {
        type: 'assistant/message',
        data: {
          message: makeMessage({
            role: 'assistant',
            content: [
              textBlock('好的'),
              toolCallBlock('c1', 'run_code', {}),
              toolCallBlock('c2', 'run_code', {}),
            ],
            source: { kind: 'model', provider: 'p', model: 'm' },
            id: 'a',
          }),
        },
      },
      {
        type: 'tool/result',
        data: {
          turn: 1,
          step: 1,
          message: makeMessage({
            role: 'user',
            content: [toolResultBlock('c1', [textBlock('r1')])],
            source: { kind: 'tool', callId: 'c1' },
            id: 'r1',
          }),
        },
      },
      {
        type: 'tool/result',
        data: {
          turn: 1,
          step: 1,
          message: makeMessage({
            role: 'user',
            content: [toolResultBlock('c2', [textBlock('r2')])],
            source: { kind: 'tool', callId: 'c2' },
            id: 'r2',
          }),
        },
      },
    ] as unknown as SessionEvent[];
    const cms = indexCompleteMessages(makeSession({ events }));
    expect(cms.map((c) => [c.type, c.callId])).toEqual([
      ['user', undefined],
      ['assistant', undefined],
      ['toolcall', 'c1'],
      ['toolcall', 'c2'],
    ]);
    expect(cms[2]?.seqs).toEqual([1, 2]);
    expect(cms[3]?.seqs).toEqual([1, 3]);
  });
});

describe('完整消息渲染 renderCompleteMessage', () => {
  it('user=原文；assistant=仅文本；toolcall=调用参数+结果', () => {
    const session = makeSession({ events: twoCallFlow() });
    const cms = indexCompleteMessages(session);
    /** 取完整消息（缺失时测试直接失败）。 */
    const cm = (index: number) => {
      const c = cms[index];
      if (!c) throw new Error(`缺少完整消息 ${index}`);
      return c;
    };
    expect(renderCompleteMessage(session, cm(0))).toContain('请帮我完成一个任务');
    expect(renderCompleteMessage(session, cm(1))).toContain('我来执行代码');
    expect(renderCompleteMessage(session, cm(1))).not.toContain('run_code'); // 文本条不含调用
    const tc = renderCompleteMessage(session, cm(2));
    expect(tc).toContain('firstCode()');
    expect(tc).toContain('out1');
  });

  it('toolcall 结果走 pruner 裁剪', () => {
    const flow = buildToolCallFlow({
      code: 'big()',
      description: '大结果',
      callId: 'cb',
      resultText: 'X'.repeat(20000),
    });
    const session = makeSession({ events: flow });
    const cms = indexCompleteMessages(session);
    const pruner = { pruneContent: () => [{ type: 'text', text: 'PRUNED' }] };
    const cm2 = cms[2];
    if (!cm2) throw new Error('缺少完整消息 2');
    const text = renderCompleteMessage(session, cm2, pruner);
    expect(text).toContain('PRUNED');
    expect(text).not.toContain('X'.repeat(20000));
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

  it('尾部保留 tailCount 条，其余压缩（区间终点回退到配对平衡点）', () => {
    const session = makeSession({ events: singleFlow() });
    // tailCount=1：表层 [0,1,3]，endIdx=1 落在 assistant(tool-call) 上 → 回退到 0
    expect(computeCompressRange(session, 1)).toEqual({
      start: 0,
      end: 0,
      shadowedSeqs: [0],
      lastEndSeq: 4,
    });
    // tailCount=0：压缩全部（result 之后平衡）
    expect(computeCompressRange(session, 0)).toEqual({
      start: 0,
      end: 3,
      shadowedSeqs: [0, 1, 3],
      lastEndSeq: 4,
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
      lastEndSeq: 4,
    });
  });

  it('无 turn/end 时仍可压缩（pre-step call-result 完备，不依赖 turn 边界）', () => {
    const flow = buildToolCallFlow({
      code: 'a()',
      description: '任务A',
      callId: 'c1',
      resultText: 'r1',
    });
    // 表层 [0,1,3]；tailCount=1 → 回退到 0；lastEndSeq 无 → -1
    expect(computeCompressRange(makeSession({ events: flow }), 1)).toEqual({
      start: 0,
      end: 0,
      shadowedSeqs: [0],
      lastEndSeq: -1,
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

  it('D：不通过文本含 <om-history> 判定摘要——普通用户消息即使含标签也不算摘要', () => {
    // 普通用户消息（非插件 source）文本里恰好含 <om-history>，不应被识别为压缩日志
    const session = makeSession({
      events: [
        {
          type: 'user/message',
          data: makeMessage({
            content: [textBlock('请解释一下 <om-history> 标签的含义')],
            id: 'user-fake',
          }),
        } as unknown as SessionEvent,
        historyMessage('真正的旧任务', 'history-real'),
      ],
    });
    // findLatestHistory 只命中插件 source 的 historyMessage，不含普通用户消息
    const found = findLatestHistory(session);
    expect(found?.seq).toBe(1);
    expect(found?.text).toContain('真正的旧任务');
    // 普通用户消息（含标签文本）不被识别为摘要
    const onlyFake = makeSession({
      events: [
        {
          type: 'user/message',
          data: makeMessage({
            content: [textBlock('请解释一下 <om-history> 标签的含义')],
            id: 'user-fake',
          }),
        } as unknown as SessionEvent,
      ],
    });
    expect(findLatestHistory(onlyFake)).toBeUndefined();
  });

  it('D：measureUncompressedTokens 将含 <om-history> 文本的普通消息计入未压缩', () => {
    const fake = makeSession({
      events: [
        {
          type: 'user/message',
          data: makeMessage({
            content: [textBlock('请解释一下 <om-history> 标签的含义')],
            id: 'user-fake',
          }),
        } as unknown as SessionEvent,
      ],
    });
    const historyOnly = makeSession({ events: [historyMessage('旧任务')] });
    expect(measureUncompressedTokens(fake, makeMeter())).toBeGreaterThan(0);
    expect(measureUncompressedTokens(historyOnly, makeMeter())).toBe(0); // 摘要消息不计入
  });
});

describe('观察提示词 buildObservePrompt', () => {
  it('任务声明/完整消息与 index/聚合规则/起始编号/中断标记/输出格式/追加说明（不含对照表与尾部规则）', () => {
    const prompt = buildObservePrompt({
      startIndex: 8,
      interruptions: ['[interrupted] turn 1 被中断（aborted，原因 user）'],
      hasOldHistory: true,
      mode: 'fork',
    });
    // fork 模式：停止任务/禁止工具声明
    expect(prompt).toContain('停止一切现有任务，禁止调用任何工具');
    // 完整消息与 index：三类定义 + 起始编号
    expect(prompt).toContain('完整消息分三类');
    expect(prompt).toContain('用户消息占一条');
    expect(prompt).toContain('AI 文本占一条');
    expect(prompt).toContain('工具调用及其结果占一条');
    expect(prompt).toContain('每个 tool-call 与其 result 各一条');
    expect(prompt).toContain('从 index 8 开始编号');
    // 规则：用户消息完整保留原文、toolcall index 行、模块 start/end、重要调用单独条目、recall 按 index 回看
    expect(prompt).toContain('完整保留原文');
    expect(prompt).toContain('toolcall index:<该条完整消息的 index>');
    expect(prompt).toContain('start/end 标注模块覆盖的 index 区间');
    expect(prompt).toContain('按模块聚合 assistant 的方式'); // 聚合方式措辞（非「与现有格式一致」）
    expect(prompt).not.toContain('与现有格式一致');
    expect(prompt).not.toContain('与现状一致');
    expect(prompt).toContain('不限于 run_code');
    expect(prompt).toContain('倾向于新消息');
    expect(prompt).toContain('不修改旧日志条目');
    expect(prompt).toContain('当前进度与下一步');
    expect(prompt).toContain('recall 按 index 回看');
    // 输出格式：合法 XML（<user_message index> / <assistant start..end> / <assistant index>）
    expect(prompt).toContain('<user_message index="(index)">');
    expect(prompt).toContain('<assistant start="(起始 index)" end="(结束 index)">');
    expect(prompt).toContain('<assistant index="(index)">');
    // 中断标记 / 追加说明；不再有对照表
    expect(prompt).toContain('[interrupted] turn 1 被中断（aborted，原因 user）');
    expect(prompt).toContain('追加到上一次压缩产物');
    expect(prompt).not.toContain('对照表');
    expect(prompt).not.toContain('message_id');
    // fork 模式：引用上方完整会话记录；尾部不写进提示词（输入已从尾部之前实际截断）
    expect(prompt).toContain('上方的消息记录是主会话的完整历史');
    expect(prompt).toContain('最后一次 <om-history> 块之后的全部消息；只对这些消息做压缩');
    expect(prompt).not.toContain('尾部');
  });

  it('首次压缩（无旧摘要）表述为第一条日志', () => {
    const prompt = buildObservePrompt({
      startIndex: 0,
      interruptions: [],
      hasOldHistory: false,
      mode: 'fork',
    });
    expect(prompt).toContain('第一条 <om-history> 压缩日志');
    expect(prompt).not.toContain('追加到上一次压缩产物');
  });

  it('new 模式：只说明总结日志 + 下方消息即压缩对象（不含旧日志/尾部）', () => {
    const prompt = buildObservePrompt({
      startIndex: 0,
      interruptions: [],
      hasOldHistory: false,
      mode: 'new',
    });
    // new 模式：仅说明总结日志（无停止任务声明）
    expect(prompt).toContain('将过往消息总结为一份日志。');
    expect(prompt).not.toContain('停止一切现有任务');
    expect(prompt).toContain('下方的消息记录是本次要压缩的全部消息');
    expect(prompt).toContain('不含旧压缩日志、不含尾部');
    expect(prompt).toContain('追加到已有压缩日志之后');
  });
});

describe('反思提示词 buildReflectPrompt', () => {
  it('精简合并规则：声明/用户消息保留要点与 index、toolcall 聚合、可写（略）、XML 输出', () => {
    const prompt = buildReflectPrompt('fork');
    expect(prompt).toContain('停止一切现有任务，禁止调用任何工具');
    expect(prompt).toContain('精简合并');
    expect(prompt).toContain('<user_message index="(index)">');
    expect(prompt).toContain('<assistant start="(起始 index)" end="(结束 index)">');
    expect(prompt).toContain('按模块聚合 assistant 的方式'); // 聚合方式措辞（非「与现有格式一致」）
    expect(prompt).not.toContain('与现有格式一致');
    expect(prompt).toContain('（略）');
    expect(prompt).toContain('index 不重新编号'); // 合并不重排，全局稳定
    expect(prompt).toContain('替换当前的 <om-history> 块内容');
    expect(prompt).toContain('保留新条目');
    expect(prompt).not.toContain('message_id');
  });

  it('new 模式定位下方的 <om-history> 压缩日志（仅说明总结日志）', () => {
    const prompt = buildReflectPrompt('new');
    expect(prompt).toContain('将当前压缩日志精简合并为一份更紧凑的日志。');
    expect(prompt).not.toContain('停止一切现有任务');
    expect(prompt).toContain('下方的消息记录包含当前的 <om-history> 压缩日志');
  });
});

describe('摘要日志提取 extractSummaryLog', () => {
  /** 构造合法日志块（inner 长度足够）。 */
  function block(inner: string): string {
    return `<om-history>\n${inner}\n</om-history>`;
  }

  it('合法块：取首个 <om-history> 到最后一个 </om-history>（含首尾），插入格式说明注释', () => {
    const raw = [
      '前置说明不要',
      block('<user_message index="0">\n请帮我完成一个任务\n</user_message>'),
      '尾部多余文字',
    ].join('\n');
    const out = extractSummaryLog(raw);
    expect(out).not.toBeNull();
    expect(out?.startsWith('<om-history>')).toBe(true);
    expect(out?.endsWith('</om-history>')).toBe(true);
    // 格式说明注释插在首个 <om-history> 之后
    expect(out).toContain(`<om-history>\n${HISTORY_FORMAT_NOTE}`);
    expect(out).toContain('<user_message index="0">');
    expect(out).not.toContain('前置说明不要');
    expect(out).not.toContain('尾部多余文字');
  });

  it('多块输出：跨首个 <om-history> 到最后一个 </om-history> 整体截取', () => {
    const raw = [block('第一块'), block('第二块')].join('\n');
    const out = extractSummaryLog(raw);
    expect(out).not.toBeNull();
    expect(out).toContain('第一块');
    expect(out).toContain('第二块');
    expect((out?.match(/<om-history>/g) ?? []).length).toBe(2);
  });

  it('找不到标签 / 顺序颠倒返回 null', () => {
    expect(extractSummaryLog('没有标签的纯文本')).toBeNull();
    expect(extractSummaryLog('</om-history>\n<om-history>')).toBeNull(); // 闭标签在开标签前
    expect(extractSummaryLog('只有开标签 <om-history> 内容')).toBeNull();
    expect(extractSummaryLog('只有闭标签 </om-history>')).toBeNull();
  });

  it('中间内容过短（< MIN_HISTORY_LENGTH）视为不合法', () => {
    expect(extractSummaryLog(block('太短'))).toBeNull();
    expect(extractSummaryLog(block(''))).toBeNull();
    expect(extractSummaryLog('<om-history>\n   \n</om-history>')).toBeNull(); // 空白不算
    expect(extractSummaryLog(block('X'.repeat(MIN_HISTORY_LENGTH)))).not.toBeNull(); // 恰好 10 合法
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

  /** 提取摘要指令文本（fork 模式为最后一条消息；new 模式为 system 字段）。 */
  function instructionText(options: ReturnType<typeof summaryOptions>): string {
    if (options.system !== undefined) return options.system;
    const last = options.messages?.at(-1);
    return String(last?.content?.[0]?.text ?? '');
  }

  /** 返回固定观察报告的 ctx（默认 window 8：观察阈值 4 tokens，必然触发）。 */
  function observeCtx(report: string, window = 8) {
    return makeCtx({
      resolveModelInfo: async () => ({ context: { contextWindow: window } }),
      llmStream: [{ type: 'text-delta', text: report }],
    });
  }

  it('触发观察：摘要调用 → 追加为 <om-history>，替换被压缩区间', async () => {
    const flowEvents = buildToolCallFlow({
      code: 'runMe()',
      description: '跑一下',
      callId: 'c-eval',
      resultText: 'done',
      withTurnEnd: true,
    });
    const session = makeSession({ events: flowEvents });
    const report = [
      '<om-history>',
      '<user_message index="0">',
      '请帮我完成一个任务',
      '</user_message>',
      '<assistant start="1" end="2">',
      'toolcall index:2 purpose:跑一下 summary:产物符合预期；下一步提交',
      '</assistant>',
      '</om-history>',
    ].join('\n');
    const ctx = observeCtx(report);
    apply(ctx, { tailMessageCount: 1 });

    expect(ctx._sections).toHaveLength(0);
    expect(ctx._registeredTools.some((t) => t.name === 'recall')).toBe(true);
    expect(ctx._registeredTools.some((t) => t.name === 'recall-semantic')).toBe(true);
    const sessionListeners = ctx._onCallbacks.get('session/event');
    expect(sessionListeners).toBeUndefined(); // 不监听 session/event

    const nextCalled = await runPreStep(ctx, session);
    expect(nextCalled).toBe(true); // 阻塞执行后放行
    expect(ctx._llmCalls).toHaveLength(1);
    const options = summaryOptions(ctx);
    // fork 模式：persona 并入指令（最后一条 user 消息）；mock requestHeader 无 system
    const instruction = instructionText(options);
    expect(instruction.startsWith(OBSERVER_PERSONA)).toBe(true);
    expect(options.system).toBeUndefined();
    expect(options.maxTokens).toBe(4096); // compressMaxTokens 默认

    const historyText = latestHistoryText(session);
    // 新格式：<user_message index> 完整原文 + <assistant start..end> 聚合模块；格式说明注释在块首
    expect(historyText).toContain('<user_message index="0">');
    expect(historyText).toContain('请帮我完成一个任务');
    expect(historyText).toContain('<assistant start="1" end="2">');
    expect(historyText).toContain(
      'toolcall index:2 purpose:跑一下 summary:产物符合预期；下一步提交',
    );
    expect(historyText).toContain('完整消息分三类'); // HISTORY_FORMAT_NOTE 注释
    // 遮蔽后表层 = <om-history> + 尾部（配对回退后保留 assistant + result 两条）
    expect(session.surface.nodes.length).toBe(3);
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
    // summary 内容 = 完整合并后的 <om-history> 内文（聊天卡片所见即所得）
    const summaryText = summaryEvent.data.summary
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    expect(summaryText).toContain('<user_message index="0">');
    expect(summaryText).toContain(
      'toolcall index:2 purpose:跑一下 summary:产物符合预期；下一步提交',
    );
    // 替换消息 source = 宿主 checkpoint 标记（plugin: 'compact' + compactionId）
    const source = checkpointSourceOf(replaceEvent);
    expect(source?.kind).toBe('plugin');
    expect(source?.plugin).toBe('compact');
    expect(source?.compactionId).toBe(compactionId);
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
    // window 11 + historyMergeRatio 2：观察阈值 5.5 ≤ 未压缩 6 tokens（触发）；
    // 反思阈值 22 > 旧摘要（含标签约 15 tokens，不触发）——隔离观察路径验证增量追加
    const ctx = observeCtx(
      '<om-history>\ntoolcall message_id:result-c1 summary:新内容\n</om-history>',
      11,
    );
    apply(ctx, { tailMessageCount: 1, historyMergeRatio: 2 });
    await runPreStep(ctx, session);
    const historyText = latestHistoryText(session);
    expect(historyText).toContain('旧任务'); // 旧摘要原文保留
    expect(historyText).toContain('新内容'); // 新观察日志追加
    const oldIdx = historyText.indexOf('旧任务');
    const newIdx = historyText.indexOf('新内容');
    expect(oldIdx).toBeGreaterThan(-1);
    expect(newIdx).toBeGreaterThan(oldIdx);
    // 多块按序拼接：替换消息原文 = 前言 + 旧 <om-history> 块 + 新 <om-history> 块
    const replaceMsg = session.events.findLast(
      (e) =>
        e.type === 'user/message' &&
        typeof e.surfaceOp === 'object' &&
        e.surfaceOp !== null &&
        (e.surfaceOp as { op?: string }).op === 'replace',
    );
    const raw = String(
      (
        (replaceMsg as { data?: { content?: unknown[] } } | undefined)?.data?.content?.[0] as
          | { text?: string }
          | undefined
      )?.text ?? '',
    );
    // 前言里的「（<om-history>）」是行内提及，不计入；块标签须独占一行（两个块 = 2 个开标签）
    expect((raw.match(/^<om-history>$/gm) ?? []).length).toBe(2);
    expect(raw.indexOf('旧任务')).toBeLessThan(raw.indexOf('新内容'));
  });

  it('未达观察阈值不压缩（无摘要调用、无 <om-history>）', async () => {
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
      resolveModelInfo: async () => ({ context: { contextWindow: 8 } }),
      llmStream: [{ type: 'text-delta', text: '' }],
    });
    apply(ctx, { tailMessageCount: 1 });
    await runPreStep(ctx, session);
    expect(ctx._llmCalls).toHaveLength(3); // 无输出视为失败，重试共 3 次
    // 摘要无输出：不写任何 compaction 生命周期事件，也无部分替换
    expect(session.events.some((e) => e.type === 'compaction/start')).toBe(false);
    expect(session.events.some((e) => e.type === 'compaction/summary')).toBe(false);
    expect(session.events.some((e) => e.type === 'compaction/end')).toBe(false);
    expect(latestHistoryText(session)).toBe(''); // 无部分替换
    // 失败日志始终输出（含尝试次数与重试耗尽说明）
    const warns = ctx._loggerCalls.filter((c) => c.level === 'warn').map((c) => String(c.args[0]));
    expect(warns.some((w) => w.includes('摘要未完成（第 1/3 次，无输出），将重试'))).toBe(true);
    expect(warns.some((w) => w.includes('重试耗尽，忽略本次摘要'))).toBe(true);
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
      resolveModelInfo: async () => ({ context: { contextWindow: 8 } }),
      llmStream: [
        { type: 'text-delta', text: '部分输出' },
        { type: 'finish', reason: { kind: 'max-tokens' } },
      ],
    });
    apply(ctx, { tailMessageCount: 1 });
    await runPreStep(ctx, session);
    expect(ctx._llmCalls).toHaveLength(3); // 非 stop 结束视为失败，重试共 3 次
    expect(session.events.some((e) => e.type === 'compaction/start')).toBe(false);
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
      resolveModelInfo: async () => ({ context: { contextWindow: 8 } }),
      llmStream: {
        [Symbol.iterator]() {
          attempts += 1;
          const current = attempts;
          return (function* () {
            if (current <= 2) throw new Error(`模拟第 ${current} 次失败`);
            yield {
              type: 'text-delta',
              text: '<om-history>\nretried-ok\n</om-history>',
            };
          })();
        },
      },
    });
    apply(ctx, { tailMessageCount: 1 });
    await runPreStep(ctx, session);
    expect(ctx._llmCalls).toHaveLength(3); // 首次 + 2 次重试
    expect(latestHistoryText(session)).toContain('retried-ok');
    expect(session.events.some((e) => e.type === 'compaction/start')).toBe(true);
    // 失败日志始终输出（含尝试次数与重试提示）
    const warns = ctx._loggerCalls.filter((c) => c.level === 'warn').map((c) => String(c.args[0]));
    expect(
      warns.some((w) => w.includes('摘要调用失败（第 1/3 次，模拟第 1 次失败），将重试')),
    ).toBe(true);
    expect(
      warns.some((w) => w.includes('摘要调用失败（第 2/3 次，模拟第 2 次失败），将重试')),
    ).toBe(true);
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
      resolveModelInfo: async () => ({ context: { contextWindow: 8 } }),
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
    apply(ctx, { tailMessageCount: 1 });
    await runPreStep(ctx, session);
    expect(ctx._llmCalls).toHaveLength(3);
    expect(session.events.some((e) => e.type === 'compaction/start')).toBe(false);
    expect(latestHistoryText(session)).toBe('');
    const warns = ctx._loggerCalls.filter((c) => c.level === 'warn').map((c) => String(c.args[0]));
    expect(warns.some((w) => w.includes('摘要调用失败（第 3/3 次，总是失败），重试耗尽'))).toBe(
      true,
    );
    expect(
      warns.some((w) => w.includes('摘要调用最终失败（已尝试 3 次，最后错误：总是失败）')),
    ).toBe(true);
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
    const ctx = observeCtx('<om-history>\nOBSERVED-PASS\n</om-history>');
    apply(ctx, { tailMessageCount: 1 });
    await runPreStep(ctx, session);
    const steps = ctx._loggerCalls
      .filter((c) => c.level === 'debug')
      .map((c) => String(c.args[0] ?? ''));
    expect(steps.some((s) => s.includes('观察检查'))).toBe(true);
    expect(steps.some((s) => s.includes('触发压缩'))).toBe(true);
    expect(steps.some((s) => s.includes('压缩区间'))).toBe(true);
    expect(steps.some((s) => s.includes('摘要调用开始（第 1/3 次'))).toBe(true);
    expect(steps.some((s) => s.includes('摘要调用成功'))).toBe(true);
    expect(steps.some((s) => s.includes('观察提交：追加 compaction/start'))).toBe(true);
    expect(steps.some((s) => s.includes('观察 pass 结束'))).toBe(true);
  });

  it('中断标记（aborted）进入观察指令', async () => {
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
      '<om-history>\nuser_message message_id:user-c1 text:请帮我完成一个任务\n</om-history>',
    );
    apply(ctx, { tailMessageCount: 1 });
    await runPreStep(ctx, session);
    const instruction = instructionText(summaryOptions(ctx));
    expect(instruction).toContain('[interrupted] turn 1 被中断（aborted，原因 user）');
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
    const ctx = observeCtx('<om-history>\ntoolcall message_id:result-c1 summary:A\n</om-history>');
    apply(ctx, { tailMessageCount: 1 });
    await runPreStep(ctx, session);
    // 区间 [0..5]（回退到 user-c2@5 平衡点），尾部保留 assistant-c2/result-c2
    const nodes = session.surface.nodes;
    expect(nodes.length).toBe(3); // <om-history> + 6,8
    expect(nodes[1]).toBe(6);
    expect(nodes[2]).toBe(8);
    // 起始 index 从 0 开始（无旧摘要）：新消息（含当前 turn 的 user-c2）从 0 编号
    const instruction = instructionText(summaryOptions(ctx));
    expect(instruction).toContain('从 index 0 开始编号');
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
    const ctx = makeCtx({ resolveModelInfo: async () => ({ context: { contextWindow: 8 } }) });
    apply(ctx, {});
    await runPreStep(ctx, session);
    expect(ctx._llmCalls).toHaveLength(0);
    expect(session.surface.nodes.length).toBe(3);
  });

  it('disable 模式：关闭自动压缩（无摘要调用、无替换、recall 工具仍注册）', async () => {
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
    const ctx = makeCtx({ resolveModelInfo: async () => ({ context: { contextWindow: 8 } }) });
    apply(ctx, { summaryMode: 'disable' });
    // 工具注册不受影响（recall 独立开关）
    expect(ctx._registeredTools.some((t) => t.name === 'recall')).toBe(true);
    await runPreStep(ctx, session);
    // 观察/反思均不触发：无摘要调用、无 compaction 生命周期、表层不变
    expect(ctx._llmCalls).toHaveLength(0);
    expect(session.events.some((e) => e.type === 'compaction/start')).toBe(false);
    expect(session.surface.nodes.length).toBe(4); // 旧日志 + flow 3 条
    const steps = ctx._loggerCalls.filter((c) => c.level === 'debug').map((c) => String(c.args[0]));
    expect(steps.some((s) => s.includes('summaryMode=disable，跳过压缩'))).toBe(true);
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

  /** 提取摘要指令文本（fork 模式为最后一条消息的文本）。 */
  function instructionText(options: unknown): string {
    const o = options as {
      messages?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
    };
    const last = o.messages?.at(-1);
    return String(last?.content?.[0]?.text ?? '');
  }

  it('摘要超反思阈值：摘要调用精简合并并替换单个 <om-history> 节点', async () => {
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
    const ctx = makeCtx({
      resolveModelInfo: async () => ({ context: { contextWindow: 16 } }),
      llmStream: [{ type: 'text-delta', text: '<om-history>\nREFLECTED-REPORT\n</om-history>' }],
    });
    apply(ctx, {});
    await runPreStep(ctx, session);
    expect(ctx._llmCalls).toHaveLength(1);
    expect(instructionText(ctx._llmCalls[0]?.options).startsWith(REFLECTOR_PERSONA)).toBe(true);
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
    // 可重入迭代器：每次 stream 调用产出一个合法 <om-history> 块——第 1 次（反思）REFLECTED，第 2 次（观察）OBSERVED
    let streamCalls = 0;
    const ctx = makeCtx({
      resolveModelInfo: async () => ({ context: { contextWindow: 8 } }),
      llmStream: {
        [Symbol.iterator]() {
          streamCalls += 1;
          const current = streamCalls;
          return (function* () {
            yield {
              type: 'text-delta',
              text:
                current === 1
                  ? '<om-history>\nREFLECTED-REPORT\n</om-history>'
                  : '<om-history>\nOBSERVED-PASS\n</om-history>',
            };
          })();
        },
      },
    });
    apply(ctx, { tailMessageCount: 1 });
    await runPreStep(ctx, session);
    expect(ctx._llmCalls).toHaveLength(2);
    const firstText = instructionText(ctx._llmCalls[0]?.options);
    const secondText = instructionText(ctx._llmCalls[1]?.options);
    expect(firstText.startsWith(REFLECTOR_PERSONA)).toBe(true); // 先反思
    expect(secondText.startsWith(OBSERVER_PERSONA)).toBe(true); // 后观察
    const text = latestHistoryText(session);
    expect(text.indexOf('REFLECTED')).toBeGreaterThan(-1);
    expect(text.indexOf('OBSERVED')).toBeGreaterThan(text.indexOf('REFLECTED'));
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
    // 摘要 40 字符 ≈ 10 tokens；window 16 × 0.2 = 3.2 → 触发反思；观察不触发
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
      resolveModelInfo: async () => ({ context: { contextWindow: 16 } }),
      llmStream: [{ type: 'text-delta', text: '<om-history>\nREFLECTED-REPORT\n</om-history>' }],
    });
    apply(ctx, {});
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
    // 单节点替换：遮蔽区间为旧 <om-history> 节点
    expect(summaryEvent.data.shadowedRange).toEqual({ start: 0, end: 0 });
    expect(summaryEvent.data.shadowedSeqs).toEqual([0]);
    expect(summaryEvent.data.provider).toBe('test');
    expect(summaryEvent.data.model).toBe('test-model');
    expect(summaryEvent.data.maxTokens).toBe(4096); // compressMaxTokens 默认
    // summary 内容 = 合并后摘要
    const summaryText = summaryEvent.data.summary
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    expect(summaryText).toContain('REFLECTED');
    // 替换消息 source = 宿主 checkpoint 标记
    const source = checkpointSourceOf(replaceEvent);
    expect(source?.plugin).toBe('compact');
    expect(source?.compactionId).toBe(startEvent.data.compactionId);
  });

  it('观察增量追加：compaction/summary 内容 = 旧摘要原文 + 新观察日志（完整内文）', async () => {
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
      resolveModelInfo: async () => ({ context: { contextWindow: 11 } }),
      llmStream: [
        {
          type: 'text-delta',
          text: '<om-history>\ntoolcall message_id:result-c1 summary:新内容\n</om-history>',
        },
      ],
    });
    // historyMergeRatio 2：反思阈值 22 > 旧摘要（含标签约 15 tokens）——隔离观察路径
    apply(ctx, { tailMessageCount: 1, historyMergeRatio: 2 });
    await runPreStep(ctx, session);
    const { start, summary } = compactionLifecycle(session);
    expect(start).not.toBe(-1);
    const summaryEvent = session.events[summary];
    if (summaryEvent?.type !== 'compaction/summary') throw new Error('缺 summary');
    const summaryText = summaryEvent.data.summary
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    expect(summaryText).toContain('旧任务'); // 旧摘要原文保留
    expect(summaryText).toContain('新内容'); // 新观察日志追加
    expect(summaryText.indexOf('旧任务')).toBeLessThan(summaryText.indexOf('新内容'));
  });
});

describe('OM 摘要 token 归入主会话（compaction/summary.usage）', () => {
  async function runPreStep(ctx: ReturnType<typeof makeCtx>, session: Session) {
    const preStepListeners = ctx._onCallbacks.get('agent/pre-step');
    await preStepListeners?.[0]?.(
      { agent: { session }, signal: new AbortController().signal },
      () => {},
    );
  }

  /** 触发观察压缩的固定夹具（window 8：观察阈值 4 tokens 必触发）。 */
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
      resolveModelInfo: async () => ({ context: { contextWindow: 8 } }),
      ...extra,
    });
    apply(ctx, { tailMessageCount: 1 });
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
          text: '<om-history>\nuser_message message_id:user-c1 text:请帮我完成一个任务\n</om-history>',
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

describe('摘要请求形态（fork / new 双模式）', () => {
  async function runPreStep(ctx: ReturnType<typeof makeCtx>, session: Session) {
    const preStepListeners = ctx._onCallbacks.get('agent/pre-step');
    await preStepListeners?.[0]?.(
      { agent: { session }, signal: new AbortController().signal },
      () => {},
    );
  }

  /** 带 requestHeader system/tools 的会话（fork 模式前缀对齐断言用）。 */
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

  it('fork 模式（缺省）：system/tools 复用主会话请求头，messages 从尾部之前实际截断', async () => {
    const session = sessionWithHeader();
    const ctx = makeCtx({ resolveModelInfo: async () => ({ context: { contextWindow: 8 } }) });
    apply(ctx, { tailMessageCount: 1 });
    await runPreStep(ctx, session);
    const options = ctx._llmCalls[0]?.options as {
      system?: string;
      tools?: unknown[];
      messages?: Array<{ role?: string; content?: Array<{ type?: string; text?: string }> }>;
    };
    expect(options?.system).toBe('主会话系统提示词');
    expect(options?.tools).toEqual([{ name: 'run_code' }]);
    // fork 从尾部之前截断：派生历史 3 条 - 尾部 2 条（assistant+result）= 1 条 + 指令
    expect(options?.messages).toHaveLength(2);
    const first = options?.messages?.[0];
    expect(String(first?.content?.[0]?.text ?? '')).toContain('请帮我完成一个任务'); // 仅被压缩的 user 消息
    const last = options?.messages?.at(-1);
    expect(last?.role).toBe('user');
    expect(String(last?.content?.[0]?.text ?? '')).toContain(OBSERVER_PERSONA);
  });

  it('new 模式（summaryMode=new）：指令作为 system，输入 = 被压缩消息（XML 包裹，不含尾部）', async () => {
    const session = sessionWithHeader();
    const ctx = makeCtx({
      resolveModelInfo: async () => ({ context: { contextWindow: 8 } }),
      llmStream: [{ type: 'text-delta', text: '<om-history>\nOBSERVED-PASS\n</om-history>' }],
    });
    apply(ctx, { summaryMode: 'new', tailMessageCount: 1 });
    await runPreStep(ctx, session);
    const options = ctx._llmCalls[0]?.options as {
      system?: string;
      messages?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
    };
    expect(options?.system?.startsWith(OBSERVER_PERSONA)).toBe(true);
    const input = String(options?.messages?.[0]?.content?.[0]?.text ?? '');
    // 输入 = 被压缩区间 [0]（tailCount=1 配对回退）的完整消息渲染（带绝对 index），不含分段标签与尾部
    expect(input).toContain('<user_message index="0">');
    expect(input).toContain('请帮我完成一个任务');
    expect(input).not.toContain('【被压缩消息】');
    expect(input).not.toContain('【参考尾部】');
    expect(input).not.toContain('message_id=user-c1'); // 不用 message_id
    expect(session.surface.nodes.length).toBe(3); // <om-history> + 尾部 assistant + result
  });
});

describe('消息渲染 renderMessages', () => {
  it('完整消息渲染：<user_message index> + <assistant index>（文本与 toolcall 分条）', () => {
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
    const text = renderMessages(session, [0, 1, 3]);
    // 用户消息 → <user_message index="0">（原文完整保留）
    expect(text).toContain('<user_message index="0">');
    expect(text).toContain('请帮我完成一个任务');
    expect(text).toContain('</user_message>');
    // 文本与 toolcall 拆开：文本 index=1，toolcall（调用+结果）index=2
    expect(text).toContain('<assistant index="1">');
    expect(text).toContain('我来执行代码');
    expect(text).toContain('<assistant index="2">');
    expect(text).toContain('[tool-call run_code id=c1]');
    expect(text).toContain('r1');
    expect(text).toContain('[result]');
    expect(text).not.toContain('message_id');
  });

  it('相邻用户消息各占一条（index 0/1）；区间外完整消息不渲染', () => {
    const session = makeSession({
      events: [
        {
          type: 'user/message',
          data: makeMessage({ content: [textBlock('你好')], id: 'u1' }),
        } as unknown as SessionEvent,
        {
          type: 'user/message',
          data: makeMessage({ content: [textBlock('再见')], id: '' }),
        } as unknown as SessionEvent,
        {
          type: 'user/message',
          data: makeMessage({ content: [textBlock('区间外')], id: 'u3' }),
        } as unknown as SessionEvent,
      ],
    });
    const text = renderMessages(session, [0, 1]);
    expect(text).toContain('<user_message index="0">');
    expect(text).toContain('你好');
    expect(text).toContain('<user_message index="1">');
    expect(text).toContain('再见');
    expect(text).not.toContain('区间外'); // 不在遮蔽集合内
  });
});

describe('recall 工具', () => {
  it('start+end 返回区间内全部完整消息（含代码与结果），输出标 index/类型', async () => {
    const session = makeSession({ events: twoCallFlow() });
    const tool = buildRecallTool();
    const exec = { agent: { session } };
    const span = await tool.execute({ start: 0, end: 5 }, exec as never);
    expect(span).toContain('firstCode()');
    expect(span).toContain('secondCode()');
    expect(span).toContain('out1');
    expect(span).toContain('out2');
    expect(String(span)).toContain('-- [index 0] user --');
    expect(String(span)).toContain('-- [index 2] toolcall callId=c1 --');
    expect(String(span)).toContain('-- [index 5] toolcall callId=c2 --');
  });

  it('end 在 start 之前时仍输出两者间全部完整消息（顺序无关）', async () => {
    const session = makeSession({ events: twoCallFlow() });
    const tool = buildRecallTool();
    const exec = { agent: { session } };
    const span = await tool.execute({ start: 5, end: 0 }, exec as never);
    expect(span).toContain('firstCode()');
    expect(span).toContain('secondCode()');
    expect(span).toContain('out1');
    expect(span).toContain('out2');
  });

  it('offset 正数从 start 向后延伸', async () => {
    const session = makeSession({ events: twoCallFlow() });
    const tool = buildRecallTool();
    const exec = { agent: { session } };
    const span = await tool.execute({ start: 1, offset: 2 }, exec as never);
    // cms 1..3：assistant 文本 + toolcall c1 + user-c2
    expect(span).toContain('firstCode()');
    expect(span).toContain('out1');
    expect(span).toContain('请帮我完成一个任务');
    expect(span).not.toContain('secondCode()');
  });

  it('offset 负数从 start 向前延伸', async () => {
    const session = makeSession({ events: twoCallFlow() });
    const tool = buildRecallTool();
    const exec = { agent: { session } };
    const span = await tool.execute({ start: 5, offset: -2 }, exec as never);
    // endIndex=3 → cms 3..5：user-c2 + assistant 文本 + toolcall c2
    expect(span).toContain('请帮我完成一个任务');
    expect(span).toContain('secondCode()');
    expect(span).toContain('out2');
    expect(span).not.toContain('out1');
  });

  it('offset 非整数自动向下取整（正负都取 floor）', async () => {
    const session = makeSession({ events: twoCallFlow() });
    const tool = buildRecallTool();
    const exec = { agent: { session } };
    const up = await tool.execute({ start: 1, offset: 2.9 }, exec as never);
    expect(up).toContain('out1');
    expect(up).not.toContain('secondCode()');
    const down = await tool.execute({ start: 5, offset: -1.5 }, exec as never);
    expect(down).toContain('secondCode()');
    expect(down).toContain('out2');
    expect(down).not.toContain('out1');
    const zero = await tool.execute({ start: 5, offset: 0 }, exec as never);
    expect(zero).toContain('secondCode()'); // toolcall 条含调用参数与结果
    expect(zero).toContain('out2');
    expect(zero).not.toContain('firstCode()');
  });

  it('end 与 offset 同时给出时 end 优先', async () => {
    const session = makeSession({ events: twoCallFlow() });
    const tool = buildRecallTool();
    const exec = { agent: { session } };
    const span = await tool.execute({ start: 0, end: 5, offset: 0 }, exec as never);
    expect(span).toContain('secondCode()');
    expect(span).toContain('out2');
  });

  it('end 与 offset 都缺省时抛错', async () => {
    const session = makeSession({ events: twoCallFlow() });
    const tool = buildRecallTool();
    const exec = { agent: { session } };
    await expect(tool.execute({ start: 0 }, exec as never)).rejects.toThrow(/至少提供一个/);
  });

  it('start/end 越界返回提示', async () => {
    const session = makeSession({ events: twoCallFlow() });
    const tool = buildRecallTool();
    const exec = { agent: { session } };
    const badStart = await tool.execute({ start: 99, offset: 1 }, exec as never);
    expect(String(badStart)).toContain('start 99 越界');
    const badEnd = await tool.execute({ start: 0, end: 99 }, exec as never);
    expect(String(badEnd)).toContain('end 99 越界');
    const badNeg = await tool.execute({ start: -1, offset: 1 }, exec as never);
    expect(String(badNeg)).toContain('start -1 越界');
  });

  it('execute 缺 start 抛错', async () => {
    const session = makeSession({ events: twoCallFlow() });
    const tool = buildRecallTool();
    const exec = { agent: { session } };
    await expect(tool.execute({ offset: 1 }, exec as never)).rejects.toThrow(/start/);
    await expect(tool.execute({}, exec as never)).rejects.toThrow(/start/);
  });

  it('execute offset 类型非法时抛错', async () => {
    const session = makeSession({ events: twoCallFlow() });
    const tool = buildRecallTool();
    const exec = { agent: { session } };
    await expect(tool.execute({ start: 0, offset: '2' }, exec as never)).rejects.toThrow(/offset/);
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
    const span = await tool.execute({ start: 2, offset: 0 }, exec as never);
    expect(String(span)).toContain('PRUNED-HEAD');
    expect(String(span)).not.toContain('X'.repeat(20000));
    const raw = await buildRecallTool().execute({ start: 2, offset: 0 }, exec as never);
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
    const result = await tool.execute({ start: 0, offset: 1 }, {
      agent: { session },
    } as never);
    expect(String(result)).toContain('仅主会话可用');
  });
});

describe('recall 参数校验（zod schema）', () => {
  it('合法参数通过解析（start 必填，end/offset 至少其一，可同时给出）', () => {
    expect(parseRecallArgs({ start: 0, offset: 2 })).toEqual({ start: 0, offset: 2 });
    expect(parseRecallArgs({ start: 0, end: 5 })).toEqual({ start: 0, end: 5 });
    expect(parseRecallArgs({ start: 0, end: 5, offset: 0 })).toEqual({
      start: 0,
      end: 5,
      offset: 0,
    });
  });

  it('缺 start 抛错并指出字段', () => {
    expect(() => parseRecallArgs({ offset: 1 })).toThrow(/start/);
    expect(() => parseRecallArgs({ end: 5 })).toThrow(/start/);
  });

  it('start/end/offset 必须为 number', () => {
    expect(() => parseRecallArgs({ start: 0, offset: '2' })).toThrow(/offset/);
    expect(() => parseRecallArgs({ start: 0, offset: null })).toThrow(/offset/);
    expect(() => parseRecallArgs({ start: '0', offset: 1 })).toThrow(/start/);
    expect(() => parseRecallArgs({ start: 0, end: '5' })).toThrow(/end/);
  });

  it('未知键被剥离', () => {
    expect(parseRecallArgs({ start: 0, offset: 1, junk: true })).toEqual({ start: 0, offset: 1 });
  });
});

describe('recall-semantic 参数解析（zod schema）', () => {
  it('query 必填且非空，top_k 与区间参数可选', () => {
    expect(parseSemanticRecallArgs({ query: '找缓存逻辑' })).toEqual({ query: '找缓存逻辑' });
    expect(parseSemanticRecallArgs({ query: 'x', top_k: 5 })).toEqual({ query: 'x', top_k: 5 });
    expect(parseSemanticRecallArgs({ query: 'x', start: 2, end: 5, offset: 1 })).toEqual({
      query: 'x',
      start: 2,
      end: 5,
      offset: 1,
    });
  });

  it('空 query / 缺失 query 抛错', () => {
    expect(() => parseSemanticRecallArgs({})).toThrow(/query/);
    expect(() => parseSemanticRecallArgs({ query: '   ' })).toThrow(/query/);
  });

  it('top_k 越界或非整数抛错（1-10）', () => {
    expect(() => parseSemanticRecallArgs({ query: 'x', top_k: 0 })).toThrow(/top_k/);
    expect(() => parseSemanticRecallArgs({ query: 'x', top_k: 11 })).toThrow(/top_k/);
    expect(() => parseSemanticRecallArgs({ query: 'x', top_k: 2.5 })).toThrow(/top_k/);
    expect(() => parseSemanticRecallArgs({ query: 'x', top_k: '3' })).toThrow(/top_k/);
  });

  it('start/end/offset 必须为 number', () => {
    expect(() => parseSemanticRecallArgs({ query: 'x', start: '2' })).toThrow(/start/);
    expect(() => parseSemanticRecallArgs({ query: 'x', end: '5' })).toThrow(/end/);
    expect(() => parseSemanticRecallArgs({ query: 'x', offset: '1' })).toThrow(/offset/);
  });

  it('未知键被剥离', () => {
    expect(parseSemanticRecallArgs({ query: 'x', junk: 1 })).toEqual({ query: 'x' });
  });
});

describe('语义区间解析 resolveSemanticRange', () => {
  it('start 缺省 → 全量检索（fallback=false）', () => {
    expect(resolveSemanticRange(3, {})).toEqual({ lo: 0, hi: 2, fallback: false });
  });

  it('start + end 限定区间（顺序无关）', () => {
    expect(resolveSemanticRange(4, { start: 0, end: 2 })).toEqual({
      lo: 0,
      hi: 2,
      fallback: false,
    });
    expect(resolveSemanticRange(4, { start: 2, end: 0 })).toEqual({
      lo: 0,
      hi: 2,
      fallback: false,
    });
  });

  it('start + offset 正负限定区间（非整数 floor）', () => {
    expect(resolveSemanticRange(4, { start: 0, offset: 2 })).toEqual({
      lo: 0,
      hi: 2,
      fallback: false,
    });
    expect(resolveSemanticRange(4, { start: 3, offset: -2 })).toEqual({
      lo: 1,
      hi: 3,
      fallback: false,
    });
    expect(resolveSemanticRange(4, { start: 0, offset: 2.9 })).toEqual({
      lo: 0,
      hi: 2,
      fallback: false,
    });
  });

  it('end 优先于 offset', () => {
    expect(resolveSemanticRange(4, { start: 0, end: 1, offset: 3 })).toEqual({
      lo: 0,
      hi: 1,
      fallback: false,
    });
  });

  it('区间越界钳制到消息边界', () => {
    expect(resolveSemanticRange(2, { start: 0, offset: 100 })).toEqual({
      lo: 0,
      hi: 1,
      fallback: false,
    });
    expect(resolveSemanticRange(2, { start: 1, offset: -100 })).toEqual({
      lo: 0,
      hi: 1,
      fallback: false,
    });
  });

  it('start/end 越界 → 回退全量并标记 fallback', () => {
    expect(resolveSemanticRange(3, { start: 99, offset: 1 })).toEqual({
      lo: 0,
      hi: 2,
      fallback: true,
    });
    expect(resolveSemanticRange(3, { start: -1, offset: 1 })).toEqual({
      lo: 0,
      hi: 2,
      fallback: true,
    });
    expect(resolveSemanticRange(3, { start: 0, end: 99 })).toEqual({
      lo: 0,
      hi: 2,
      fallback: true,
    });
  });

  it('空索引（total=0）→ 空区间（不标记回退）', () => {
    expect(resolveSemanticRange(0, {})).toEqual({ lo: 0, hi: -1, fallback: false });
  });
});

describe('cosine 相似度 cosineSimilarity', () => {
  it('相同向量 = 1，正交 = 0，零向量 = 0', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity(new Float32Array(4), new Float32Array(4))).toBe(0);
  });

  it('未归一化向量自动归一化（比例不变）', () => {
    expect(cosineSimilarity([2, 0], [1, 0])).toBeCloseTo(1, 10);
    expect(cosineSimilarity([3, 4], [0, 1])).toBeCloseTo(0.8, 10);
  });
});

describe('匹配说明 matchExplanation', () => {
  it('含相似度与命中的关键词（最多 8 个）', () => {
    const line = matchExplanation('retry backoff 重试退避', '实现 retry backoff 逻辑', 0.87);
    expect(line).toContain('0.870');
    expect(line).toContain('retry');
    expect(line).toContain('backoff');
  });

  it('无共有词时省略关键词部分', () => {
    const line = matchExplanation('数据库权限', 'hello world', 0.2);
    expect(line).toContain('相似度');
    expect(line).not.toContain('命中关键词');
  });
});

describe('recall-semantic 工具', () => {
  /** 构造纯 user/message 会话（每个 id 一条文本）。 */
  function textSession(texts: Array<[string, string]>, header?: { origin?: 'subagent' }) {
    const events = texts.map(
      ([id, text]) =>
        ({
          type: 'user/message',
          data: makeMessage({ content: [textBlock(text)], id }),
        }) as unknown as SessionEvent,
    );
    return makeSession({ events, ...(header ? { header } : {}) });
  }

  /** 可编程 embedder 替身：按关键词命中产出 3 维 one-hot 向量（未命中全 0，相似度为 0）。 */
  function fakeEmbedder() {
    return async (texts: readonly string[]) =>
      texts.map((text) => {
        const vec = new Float32Array(3);
        const lower = text.toLowerCase();
        if (lower.includes('缓存')) vec[0] = 1;
        if (lower.includes('数据库')) vec[1] = 1;
        if (lower.includes('权限')) vec[2] = 1;
        return vec;
      });
  }

  it('按语义相似度排序返回 top_k 完整消息（默认 3）', async () => {
    const session = textSession([
      ['m-db', '修改数据库连接池配置'],
      ['m-cache', '缓存失效问题排查'],
      ['m-db-cache', '数据库查询走缓存'],
      ['m-auth', '权限校验逻辑'],
      ['m-log', '日志输出格式'],
    ]);
    const tool = buildSemanticRecallTool({ embedder: fakeEmbedder() });
    const exec = { agent: { session } };
    const span = await tool.execute({ query: '数据库 缓存' }, exec as never);
    const out = String(span);
    // 最匹配 3 条按分数降序：同时含数据库+缓存 > 单数据库 > 单缓存
    const idxDbCache = out.indexOf('数据库查询走缓存');
    const idxDb = out.indexOf('修改数据库连接池配置');
    const idxCache = out.indexOf('缓存失效问题排查');
    expect(idxDbCache).toBeGreaterThan(-1);
    expect(idxDbCache).toBeLessThan(idxDb);
    expect(idxDb).toBeLessThan(idxCache);
    expect(out).toContain('数据库查询走缓存');
    expect(out).toContain('修改数据库连接池配置');
    expect(out).toContain('缓存失效问题排查');
    expect(out).not.toContain('权限校验逻辑');
    expect(out).not.toContain('日志输出格式');
    expect(out).toContain('index 2 user'); // m-db-cache 为完整消息 index 2
    expect(out).toContain('相似度');
  });

  it('top_k 参数可覆盖默认 3', async () => {
    const session = textSession([
      ['m-db', '修改数据库连接池配置'],
      ['m-cache', '缓存失效问题排查'],
      ['m-db-cache', '数据库查询走缓存'],
      ['m-auth', '权限校验逻辑'],
      ['m-log', '日志输出格式'],
    ]);
    const tool = buildSemanticRecallTool({ embedder: fakeEmbedder() });
    const exec = { agent: { session } };
    const span = await tool.execute({ query: '数据库 缓存', top_k: 5 }, exec as never);
    const out = String(span);
    expect(out).toContain('权限校验逻辑');
    expect(out).toContain('日志输出格式');
    const top1 = await tool.execute({ query: '数据库 缓存', top_k: 1 }, exec as never);
    expect(String(top1)).toContain('数据库查询走缓存');
    expect(String(top1)).not.toContain('修改数据库连接池配置');
  });

  it('被压缩/遮蔽的消息仍在检索范围（全部日志）', async () => {
    // 模拟压缩：遮蔽部分 seq（表层仅剩最新一条），但日志中消息仍可被语义找回
    const events = [
      {
        type: 'user/message',
        data: makeMessage({ content: [textBlock('早期讨论过数据库索引优化')], id: 'old-db' }),
      },
      {
        type: 'user/message',
        data: makeMessage({ content: [textBlock('缓存过期策略')], id: 'old-cache' }),
      },
      {
        type: 'user/message',
        data: makeMessage({ content: [textBlock('当前在做权限模块')], id: 'now-auth' }),
      },
    ] as unknown as SessionEvent[];
    const session = makeSession({ events, surfaceNodes: [2] }); // 0、1 被压缩遮蔽
    const tool = buildSemanticRecallTool({ embedder: fakeEmbedder() });
    const exec = { agent: { session } };
    const span = await tool.execute({ query: '数据库', top_k: 3 }, exec as never);
    const out = String(span);
    expect(out).toContain('早期讨论过数据库索引优化');
    expect(out).toContain('index 0 user'); // old-db 为完整消息 index 0
  });

  it('start+offset 限定检索区间（完整消息 index）', async () => {
    const session = textSession([
      ['m-db', '修改数据库连接池配置'],
      ['m-cache', '缓存失效问题排查'],
      ['m-auth', '权限校验逻辑'],
    ]);
    const tool = buildSemanticRecallTool({ embedder: fakeEmbedder() });
    const exec = { agent: { session } };
    // 区间 [0..1]（m-db .. m-cache）：不含权限消息
    const span = await tool.execute({ query: '权限 数据库', start: 0, offset: 1 }, exec as never);
    const out = String(span);
    expect(out).toContain('修改数据库连接池配置');
    expect(out).toContain('缓存失效问题排查');
    expect(out).not.toContain('权限校验逻辑');
  });

  it('区间越界 → 回退全量并在输出中告知', async () => {
    const session = textSession([
      ['m-db', '修改数据库连接池配置'],
      ['m-cache', '缓存失效问题排查'],
      ['m-auth', '权限校验逻辑'],
    ]);
    const tool = buildSemanticRecallTool({ embedder: fakeEmbedder() });
    const exec = { agent: { session } };
    const span = await tool.execute({ query: '权限', start: 99, offset: 2 }, exec as never);
    const out = String(span);
    expect(out).toContain('已回退检索全部消息');
    expect(out).toContain('权限校验逻辑'); // 全量检索可见
  });

  it('范围描述：无区间时标注检索全部消息', async () => {
    const session = textSession([['m-auth', '权限校验逻辑']]);
    const tool = buildSemanticRecallTool({ embedder: fakeEmbedder() });
    const exec = { agent: { session } };
    const span = await tool.execute({ query: '权限' }, exec as never);
    expect(String(span)).toContain('检索全部消息');
  });

  it('tool-result-pruner 裁剪超大命中消息', async () => {
    const events = [
      {
        type: 'user/message',
        data: makeMessage({ content: [textBlock('数据库权限问题说明')], id: 'big-db' }),
      },
      {
        type: 'tool/result',
        data: {
          message: makeMessage({
            role: 'user',
            content: [
              {
                type: 'tool-result',
                toolCallId: 'tc1',
                content: [{ type: 'text', text: 'X'.repeat(20000) }],
              },
            ],
            source: { kind: 'tool', callId: 'tc1' },
            id: 'big-result',
          }),
        },
      },
    ] as unknown as SessionEvent[];
    const session = makeSession({ events });
    const prunedBlocks = [{ type: 'text', text: 'PRUNED-SEMANTIC' }];
    const tool = buildSemanticRecallTool({
      embedder: fakeEmbedder(),
      getPruner: () => ({
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
      }),
    });
    const exec = { agent: { session } };
    const span = await tool.execute({ query: '数据库权限', top_k: 3 }, exec as never);
    const out = String(span);
    // 未裁剪时 20000 个 X 会溢出输出；裁剪后不出现
    expect(out).not.toContain('X'.repeat(20000));
  });

  it('subagent 会话调用被拒绝', async () => {
    const session = textSession([['m-db', '数据库配置']], { origin: 'subagent' });
    const tool = buildSemanticRecallTool({ embedder: fakeEmbedder() });
    const result = await tool.execute({ query: '数据库' }, { agent: { session } } as never);
    expect(String(result)).toContain('仅主会话可用');
  });

  it('无可检索消息返回提示', async () => {
    const session = makeSession({ events: [] });
    const tool = buildSemanticRecallTool({ embedder: fakeEmbedder() });
    const exec = { agent: { session } };
    const span = await tool.execute({ query: '数据库' }, exec as never);
    expect(String(span)).toContain('没有可检索的消息');
  });

  it('模型未就绪：返回告知文案（不报错、不触发嵌入）', async () => {
    const session = textSession([['m-db', '数据库配置']]);
    let embedded = false;
    const tool = buildSemanticRecallTool({
      embedder: async (texts) => {
        embedded = true;
        return fakeEmbedder()(texts);
      },
      modelStatus: async () => 'downloading' as const,
    });
    const result = await tool.execute({ query: '数据库' }, { agent: { session } } as never);
    const out = String(result);
    expect(out).toContain('尚未就绪');
    expect(out).toContain('recall');
    expect(embedded).toBe(false);
  });

  it('模型就绪（ready）时正常执行检索', async () => {
    const session = textSession([['m-db', '数据库配置']]);
    const tool = buildSemanticRecallTool({
      embedder: fakeEmbedder(),
      modelStatus: async () => 'ready' as const,
    });
    const out = String(await tool.execute({ query: '数据库' }, { agent: { session } } as never));
    expect(out).toContain('数据库配置');
    expect(out).toContain('index 0 user'); // m-db 为完整消息 index 0
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

// 保证入口导出形态稳定（Loader 依赖）
describe('插件入口导出', () => {
  it('导出 name/inject/apply 且无 default', () => {
    expect(name).toBe('dsh-plugin-om');
    expect(inject).toEqual(['tools', 'llm', 'tokenMeter', 'sessions']);
    expect(typeof apply).toBe('function');
  });
});
