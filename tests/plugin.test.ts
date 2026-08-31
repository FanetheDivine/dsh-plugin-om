// dsh-plugin-om 单元测试（vitest）：配置校验 / 消息索引 /
// OM 两级压缩（观察/反思 new 摘要）/ recall（范围+拒绝+参数校验）/ apply 接线。
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
  measureUncompressedTokens,
} from '../src/compress.ts';
import { resolveConfig } from '../src/config.ts';
import {
  COMPLETE_MESSAGE_DEFINITION,
  HISTORY_TAG,
  HISTORY_TIP,
  PLUGIN_LABEL,
} from '../src/constants.ts';
import { cosineSimilarity, ensureModelReady, sharedModelDir } from '../src/embedding.ts';
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
  SEMANTIC_MODEL_NOT_READY_MESSAGE,
} from '../src/semantic-recall.ts';
import {
  buildHistoryPrompt,
  extractSummaryLog,
  HISTORY_FORMAT_NOTE,
  historyContinuity,
  parseHistoryEntries,
  renderMessages,
} from '../src/summarize.ts';
import type { CompactionSummaryPayload, Session, SessionEvent } from '../src/types.ts';
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

/** 从会话日志提取最后一次 <history> 消息的完整文本（去标签）。 */
function latestHistoryText(session: Session): string {
  const historyMsg = session.events.findLast(
    (e) =>
      e.type === 'user/message' &&
      String(
        ((e.data as { content?: unknown[] }).content?.[0] as { text?: string } | undefined)?.text ??
          '',
      ).includes(`<${HISTORY_TAG}`), // 兼容带 tip 属性的开标签（<history tip="…">）
  );
  const text = String(
    (
      (historyMsg as { data?: { content?: unknown[] } } | undefined)?.data?.content?.[0] as
        | { text?: string }
        | undefined
    )?.text ?? '',
  );
  return text.replace(new RegExp(`</?${HISTORY_TAG}[^>]*>`, 'g'), '').trim();
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

/** 提取 <history> 替换消息的 source（来源标记断言用）。 */
function checkpointSourceOf(event: SessionEvent | undefined) {
  if (event?.type !== 'user/message') return undefined;
  return event.data.source as { kind?: string; plugin?: string; compactionId?: string } | undefined;
}

/** 构造 <history> 压缩日志消息（插件自产 user/message，seq 从 0 起；与真实消息一致：无前缀句，tip 属性在开标签上）。 */
function historyMessage(inner: string, id = 'history-msg'): SessionEvent {
  return {
    type: 'user/message',
    data: makeMessage({
      content: [textBlock(`<${HISTORY_TAG} tip="${HISTORY_TIP}">\n${inner}\n</${HISTORY_TAG}>`)],
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
    expect(d.thresholdRatio).toBe(0.1);
    expect(d.historyMergeRatio).toBe(0.2);
    expect(d.compressMaxTokens).toBe(10000);
    expect(d.tailMessageCount).toBe(10);
    expect(d.compressRetryCount).toBe(10); // 失败后最大重试次数（不含首次）
    expect(d.omEnabled).toBe(true); // 缺省启用 OM
    expect(d.debug).toBe(process.env.NODE_ENV !== 'production'); // 缺省按 NODE_ENV 判定
    expect(d.recallEnabled).toBe(true);
    expect(d.semanticRecallEnabled).toBe(true);
    expect(d.modelDir).toBe(sharedModelDir()); // 默认跨版本共享目录
    expect(d).not.toHaveProperty('summaryMode'); // summaryMode 已移除
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

  it('tailMessageCount：默认 10，任意数值可覆盖（不做区间限制），非整数回退默认', () => {
    expect(resolveConfig({}).tailMessageCount).toBe(10);
    expect(resolveConfig({ tailMessageCount: 3 }).tailMessageCount).toBe(3);
    expect(resolveConfig({ tailMessageCount: 0 }).tailMessageCount).toBe(0); // 无区间限制
    expect(resolveConfig({ tailMessageCount: 2.5 }).tailMessageCount).toBe(10); // 非整数回退默认
  });

  it('compressRetryCount：默认 10（失败后最大重试次数），整数可覆盖，非整数回退默认', () => {
    expect(resolveConfig({}).compressRetryCount).toBe(10);
    expect(resolveConfig({ compressRetryCount: 3 }).compressRetryCount).toBe(3);
    expect(resolveConfig({ compressRetryCount: 0 }).compressRetryCount).toBe(0); // 无区间限制
    expect(resolveConfig({ compressRetryCount: 2.5 }).compressRetryCount).toBe(10); // 非整数回退默认
    expect(resolveConfig({ compressRetryCount: '5' }).compressRetryCount).toBe(10); // 非数值回退默认
  });

  it('整份配置留空（undefined/null/空串/空白串）时全部用默认值', () => {
    const empty = [undefined, null, '', '   '];
    for (const raw of empty) {
      const d = resolveConfig(raw);
      expect(d.thresholdRatio).toBe(0.1);
      expect(d.historyMergeRatio).toBe(0.2);
      expect(d.compressMaxTokens).toBe(10000);
      expect(d.tailMessageCount).toBe(10);
      expect(d.compressRetryCount).toBe(10);
      expect(d.omEnabled).toBe(true);
      expect(d.recallEnabled).toBe(true);
      expect(d.semanticRecallEnabled).toBe(true);
    }
  });

  it('单项留空（null/空串/undefined）该键用默认值，其余覆盖项仍生效', () => {
    expect(resolveConfig({ thresholdRatio: null }).thresholdRatio).toBe(0.1);
    expect(resolveConfig({ thresholdRatio: '' }).thresholdRatio).toBe(0.1);
    const mixed = resolveConfig({ thresholdRatio: undefined, historyMergeRatio: 0.3 });
    expect(mixed.thresholdRatio).toBe(0.1);
    expect(mixed.historyMergeRatio).toBe(0.3);
    const mixed2 = resolveConfig({ compressMaxTokens: null, tailMessageCount: 3 });
    expect(mixed2.compressMaxTokens).toBe(10000);
    expect(mixed2.tailMessageCount).toBe(3);
  });

  it('宽松校验：未知键忽略、不合法值回退默认（不影响插件加载）', () => {
    expect(resolveConfig([])).toEqual(resolveConfig({})); // 空数组不是对象，回归默认
    expect(resolveConfig('0.5')).toEqual(resolveConfig({})); // 非空字符串不是对象，回归默认
    expect(resolveConfig({ badKey: 1 })).toEqual(resolveConfig({})); // 未知键忽略
    // 阈值不做 0.01-1 区间限制：任意数值（调试场景）按原样接受
    expect(resolveConfig({ thresholdRatio: 2 }).thresholdRatio).toBe(2);
    expect(resolveConfig({ historyMergeRatio: 0 }).historyMergeRatio).toBe(0);
    expect(resolveConfig({ historyMergeRatio: 2 }).historyMergeRatio).toBe(2);
    expect(resolveConfig({ compressMaxTokens: 0 }).compressMaxTokens).toBe(0);
    expect(resolveConfig({ thresholdRatio: '0.5' }).thresholdRatio).toBe(0.1); // 非数值回退默认
    expect(resolveConfig({ compressMaxTokens: 2.5 }).compressMaxTokens).toBe(10000); // 非整数回退默认
    // 全部未知键被忽略 → 结果等于默认配置
    expect(
      resolveConfig({
        summaryMaxChars: 100,
        recallMaxMessages: 10,
        tailMessageBudget: 50,
        tailTokenBudgetRatio: 0.1,
        auto: false,
        evalEnabled: false,
        envDebug: true, // 环境变量名不再是配置键
      }),
    ).toEqual(resolveConfig({}));
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

  it('非 boolean 值回退默认；留空回退默认', () => {
    expect(resolveConfig({ debug: 'true' }).debug).toBe(process.env.NODE_ENV !== 'production');
    expect(resolveConfig({ debug: 1 }).debug).toBe(process.env.NODE_ENV !== 'production');
    expect(resolveConfig({ debug: null }).debug).toBe(process.env.NODE_ENV !== 'production');
    expect(resolveConfig({ debug: '' }).debug).toBe(process.env.NODE_ENV !== 'production');
  });
});

describe('omEnabled 配置键', () => {
  it('缺省启用（true）；留空（null/空串）回退默认', () => {
    expect(resolveConfig({}).omEnabled).toBe(true);
    expect(resolveConfig({ omEnabled: null }).omEnabled).toBe(true);
    expect(resolveConfig({ omEnabled: '' }).omEnabled).toBe(true);
    expect(resolveConfig({ omEnabled: '   ' }).omEnabled).toBe(true);
  });

  it('true / false 显式开关', () => {
    expect(resolveConfig({ omEnabled: true }).omEnabled).toBe(true);
    expect(resolveConfig({ omEnabled: false }).omEnabled).toBe(false);
  });

  it('不合法值回退默认（true）', () => {
    expect(resolveConfig({ omEnabled: 'false' }).omEnabled).toBe(true); // 字符串不合法
    expect(resolveConfig({ omEnabled: 0 }).omEnabled).toBe(true);
    expect(resolveConfig({ omEnabled: 'bogus' }).omEnabled).toBe(true);
  });

  it('summaryMode 不再是配置键（忽略、回归默认）', () => {
    expect(resolveConfig({ summaryMode: 'new' }).omEnabled).toBe(true); // 未知键忽略
    expect(resolveConfig({ summaryMode: 'fork' })).not.toHaveProperty('summaryMode');
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

  it('非 boolean 值回退默认（启用）', () => {
    expect(resolveConfig({ recallEnabled: 'false' }).recallEnabled).toBe(true);
    expect(resolveConfig({ semanticRecallEnabled: 0 }).semanticRecallEnabled).toBe(true);
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

  it('本插件自产消息不占位；其他插件/宿主注入的 user_message 为系统消息（sys）占位', () => {
    const session = makeSession({
      events: [
        historyMessage('旧任务'), // 本插件压缩日志（source.kind=plugin + plugin=dsh-plugin-om）不占位
        ...twoCallFlow(),
        {
          type: 'user/message',
          data: makeMessage({
            content: [textBlock('其他插件的运行时上下文快照')],
            source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' },
            id: 'snap',
          }),
        } as unknown as SessionEvent,
      ],
    });
    const cms = indexCompleteMessages(session);
    // 两条流程 6 条 + 其他插件快照 1 条（系统消息）；本插件 <history> 块不占位
    expect(cms).toHaveLength(7);
    expect(cms[0]?.type).toBe('user');
    expect(cms[6]?.type).toBe('sys');
    expect(cms[6]?.kind).toBe('plugin'); // sys.kind = source.kind（区分 kind:user 与其余）
    expect(cms[6]?.seqs).toEqual([9]); // 快照事件 seq（history@0 + 两条流程 0..7 + 快照@9）
  });

  it('kind:user 归为用户消息；其余 kind 归为系统消息（sys 记录 kind）', () => {
    const session = makeSession({
      events: [
        {
          type: 'user/message',
          data: makeMessage({
            content: [textBlock('宿主注入的工作区指令')],
            source: { kind: 'agent-instructions' },
            id: 'sys-inst',
          }),
        } as unknown as SessionEvent,
        {
          type: 'user/message',
          data: makeMessage({ content: [textBlock('用户直接输入')], id: 'u-direct' }),
        } as unknown as SessionEvent,
        {
          type: 'user/message',
          data: makeMessage({
            content: [textBlock('技能目录')],
            source: { kind: 'skill-catalog', form: 'catalog' },
            id: 'sys-catalog',
          }),
        } as unknown as SessionEvent,
      ],
    });
    const cms = indexCompleteMessages(session);
    expect(cms.map((c) => [c.type, c.kind])).toEqual([
      ['sys', 'agent-instructions'],
      ['user', undefined],
      ['sys', 'skill-catalog'],
    ]);
    expect(cms.map((c) => c.index)).toEqual([0, 1, 2]); // 系统消息也占 index
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

  it('sys=消息原文（recall 呈现系统消息原始内容）', () => {
    const session = makeSession({
      events: [
        {
          type: 'user/message',
          data: makeMessage({
            content: [textBlock('宿主注入的指令原文')],
            source: { kind: 'agent-instructions' },
            id: 'sys-1',
          }),
        } as unknown as SessionEvent,
      ],
    });
    const cms = indexCompleteMessages(session);
    const cm = cms[0];
    if (!cm) throw new Error('缺少完整消息 0');
    expect(cm.type).toBe('sys');
    expect(renderCompleteMessage(session, cm)).toBe('宿主注入的指令原文');
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
  it('表层节点合计，不含 <history> 摘要节点', () => {
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

  it('系统消息（非 kind:user 的 user_message，如宿主注入上下文）不计入未压缩消息', () => {
    const events = [
      {
        type: 'user/message',
        data: makeMessage({
          content: [textBlock('宿主注入的工作区指令，很长的一段说明')],
          source: { kind: 'agent-instructions' },
          id: 'sys-1',
        }),
      } as unknown as SessionEvent,
      {
        type: 'user/message',
        data: makeMessage({ content: [textBlock('真正的用户请求')], id: 'u-1' }),
      } as unknown as SessionEvent,
    ];
    const session = makeSession({ events });
    const meter = makeMeter();
    // 仅 kind:user 的用户消息计入；系统消息整条跳过
    expect(measureUncompressedTokens(session, meter)).toBe(estimateTextTokens('真正的用户请求'));
  });

  it('整条仅为系统消息时测量为 0', () => {
    const session = makeSession({
      events: [
        {
          type: 'user/message',
          data: makeMessage({
            content: [textBlock('<system-reminder>\nnotice\n</system-reminder>')],
            source: { kind: 'agent-instructions' },
            id: 'sys-only',
          }),
        } as unknown as SessionEvent,
      ],
    });
    expect(measureUncompressedTokens(session, makeMeter())).toBe(0);
  });

  it('用户消息中的 <system-reminder> 文本仍计入未压缩消息（不再特殊扣除）', () => {
    const session = makeSession({
      events: [
        {
          type: 'user/message',
          data: makeMessage({
            content: [textBlock('<system-reminder>\nworkspace instructions\n</system-reminder>')],
            id: 'u-sr',
          }),
        } as unknown as SessionEvent,
      ],
    });
    const meter = makeMeter();
    expect(measureUncompressedTokens(session, meter)).toBe(
      estimateTextTokens('<system-reminder>\nworkspace instructions\n</system-reminder>'),
    );
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

  it('D：measureUncompressedTokens 只计最后一个 history 块之后的节点', () => {
    const fake = makeSession({
      events: [
        {
          type: 'user/message',
          data: makeMessage({
            content: [textBlock('请解释一下 <history> 标签的含义')],
            id: 'user-fake',
          }),
        } as unknown as SessionEvent,
      ],
    });
    const historyOnly = makeSession({ events: [historyMessage('旧任务')] });
    expect(measureUncompressedTokens(fake, makeMeter())).toBeGreaterThan(0);
    expect(measureUncompressedTokens(historyOnly, makeMeter())).toBe(0); // 边界后无节点
    // 边界后的普通消息计入未压缩
    const stray = makeSession({
      events: [
        historyMessage('旧任务'),
        ...buildToolCallFlow({ code: 'a()', description: '任务A', callId: 'c1', resultText: 'r1' }),
      ],
    });
    expect(measureUncompressedTokens(stray, makeMeter())).toBeGreaterThan(0);
  });
});

describe('共享提示词 buildHistoryPrompt（观察/反思同一套）', () => {
  it('定义 history 块 / 完整消息定义串 / 压缩要求（a-f）/ 输出格式 / 数据源', () => {
    const prompt = buildHistoryPrompt();
    // 任务声明：压缩下方 <history> 记录
    expect(prompt).toContain('压缩为一份更紧凑的 <history> 压缩日志');
    expect(prompt).not.toContain('停止一切现有任务');
    // a. 模型消息 + index 的表达形式（输入与输出都是合法 <history> 块）
    expect(prompt).toContain('输入与输出都是合法的 <history> 块');
    expect(prompt).toContain('「模型消息 + index」的表达形式');
    // 完整消息定义串（与 recall 工具共用）
    expect(prompt).toContain(COMPLETE_MESSAGE_DEFINITION);
    expect(prompt).toContain('用户消息');
    expect(prompt).toContain('模型输出文本');
    expect(prompt).toContain('具有result的toolcall');
    expect(prompt).toContain('首条`完整消息`的index是0');
    // 条目标签语义
    expect(prompt).toContain('<user_message index="N">');
    expect(prompt).toContain('<reasoning>');
    expect(prompt).toContain('<assistant index="N">');
    expect(prompt).toContain('<assistant start="A" end="B">');
    // 系统消息条目（<sys> 空块：type=kind、index；块中为空）
    expect(prompt).toContain('<sys type="(kind)" index="N">');
    expect(prompt).toContain('系统消息');
    expect(prompt).toContain('块中为空');
    // b. 要求压缩
    expect(prompt).toContain('把下方的 <history> 消息记录压缩');
    // c. 完整保留用户消息
    expect(prompt).toContain('完整保留用户消息');
    expect(prompt).toContain('逐条保留原文，不概括、不省略');
    // d. reasoning 仅参考，产物中没有
    expect(prompt).toContain('<reasoning> 只作参考，输出产物中不包含 <reasoning> 块');
    // e. 具有关联性的 assistant 块合并
    expect(prompt).toContain('将具有关联性的 <assistant> 消息');
    expect(prompt).toContain('目的、行为与结果');
    expect(prompt).toContain('合并简写');
    expect(prompt).toContain('内在逻辑连贯性');
    // 单条重要消息单独呈现
    expect(prompt).toContain('单条重要的完整消息以 <assistant index=""> 单独呈现');
    // f. index/start/end 必须连续
    expect(prompt).toContain('index/start/end 必须连续');
    expect(prompt).toContain('不跳号、不重叠、不遗漏');
    // 输出格式：一个合法 <history> 块（无 reasoning），含 <sys> 空块示例
    expect(prompt).toContain('只输出一个 <history> 包裹的合法 XML 日志块');
    expect(prompt).toContain('<user_message index="(index)">');
    expect(prompt).toContain('<sys type="(kind)" index="(index)"></sys>');
    expect(prompt).toContain('<assistant start="(起始 index)" end="(结束 index)">');
    expect(prompt).toContain('<assistant index="(index)">');
    // 数据源说明（先定义块、要求压缩、再给出数据源）
    expect(prompt).toContain('【数据源】下方的 <history> 消息记录是本次要压缩的全部消息');
    expect(prompt).not.toContain('message_id');
    expect(prompt).not.toContain('[interrupted]');
  });
});

describe('history 条目解析与连续性 parseHistoryEntries / historyContinuity', () => {
  it('解析 user_message/assistant index 与 assistant start..end（合法 <history> 块内）', () => {
    const text = [
      '<history>',
      '<user_message index="0">',
      'x',
      '</user_message>',
      '<assistant start="1" end="2">',
      'm',
      '</assistant>',
      '<assistant index="3">',
      'y',
      '</assistant>',
      '</history>',
    ].join('\n');
    expect(parseHistoryEntries(text)).toEqual([
      { kind: 'user', index: 0 },
      { kind: 'assistant', start: 1, end: 2 },
      { kind: 'assistant', index: 3 },
    ]);
  });

  it('解析 sys 系统消息条目（index 参与连续性校验）', () => {
    const text = [
      '<history>',
      '<sys type="agent-instructions" index="0"></sys>',
      '<user_message index="1">',
      'x',
      '</user_message>',
      '<assistant start="2" end="3">',
      'm',
      '</assistant>',
      '</history>',
    ].join('\n');
    expect(parseHistoryEntries(text)).toEqual([
      { kind: 'sys', index: 0 },
      { kind: 'user', index: 1 },
      { kind: 'assistant', start: 2, end: 3 },
    ]);
    // sys 按单条 index 参与连续性
    expect(
      historyContinuity([
        { kind: 'sys', index: 0 },
        { kind: 'user', index: 1 },
        { kind: 'assistant', start: 2, end: 3 },
      ]),
    ).toEqual({ start: 0, end: 3 });
  });

  it('连续性：单条与模块按序相接（后一条 lo = 前一条 hi + 1）', () => {
    expect(
      historyContinuity([
        { kind: 'user', index: 0 },
        { kind: 'assistant', start: 1, end: 2 },
        { kind: 'assistant', index: 3 },
      ]),
    ).toEqual({ start: 0, end: 3 });
    expect(
      historyContinuity([
        { kind: 'assistant', start: 5, end: 8 },
        { kind: 'assistant', index: 9 },
      ]),
    ).toEqual({ start: 5, end: 9 });
  });

  it('不连续（跳号/重叠）/ 非法范围 / 空条目返回 null', () => {
    expect(historyContinuity([])).toBeNull();
    expect(
      historyContinuity([
        { kind: 'user', index: 0 },
        { kind: 'user', index: 2 },
      ]),
    ).toBeNull(); // 跳号
    expect(
      historyContinuity([
        { kind: 'user', index: 0 },
        { kind: 'user', index: 0 },
      ]),
    ).toBeNull(); // 重叠
    expect(
      historyContinuity([
        { kind: 'user', index: 1 },
        { kind: 'user', index: 0 },
      ]),
    ).toBeNull(); // 乱序不接
    expect(historyContinuity([{ kind: 'assistant', start: 2, end: 1 }])).toBeNull(); // start > end
  });
});

describe('摘要日志提取 extractSummaryLog', () => {
  /** 构造合法日志块（inner 长度足够）。 */
  function block(inner: string): string {
    return `<${HISTORY_TAG}>\n${inner}\n</${HISTORY_TAG}>`;
  }

  it('合法块：取首个 <history> 到最后一个 </history>（含首尾），开标签带 tip 属性，块顶插入格式说明注释', () => {
    const raw = [
      '前置说明不要',
      block('<user_message index="0">\n请帮我完成一个任务\n</user_message>'),
      '尾部多余文字',
    ].join('\n');
    const out = extractSummaryLog(raw);
    expect(out).not.toBeNull();
    expect(out?.startsWith(`<${HISTORY_TAG} tip="${HISTORY_TIP}">`)).toBe(true);
    expect(out?.endsWith(`</${HISTORY_TAG}>`)).toBe(true);
    // tip 属性即对 AI 的提醒；格式说明注释插在带 tip 的开标签之后（块顶）
    expect(out).toContain(`<${HISTORY_TAG} tip="${HISTORY_TIP}">\n${HISTORY_FORMAT_NOTE}`);
    expect(out).toContain('<user_message index="0">');
    expect(out).not.toContain('前置说明不要');
    expect(out).not.toContain('尾部多余文字');
  });

  it('含 <sys> 系统消息空块的日志合法（type/index 保留，连续性含 sys）', () => {
    const raw = block(
      '<sys type="agent-instructions" index="0"></sys>\n<user_message index="1">\nA\n</user_message>',
    );
    const out = extractSummaryLog(raw);
    expect(out).not.toBeNull();
    expect(out).toContain('<sys type="agent-instructions" index="0"></sys>');
    expect(out).toContain('<user_message index="1">');
    // 缺 index 的 <sys> 条目视为不合法
    expect(extractSummaryLog(block('<sys type="agent-instructions"></sys>'))).toBeNull();
  });

  it('多块输出视为不合法（输出必须是单个合法 <history> 块，XML 解析拒绝多根）', () => {
    const raw = [
      block('<user_message index="0">\nA\n</user_message>'),
      block('<user_message index="1">\nB\n</user_message>'),
    ].join('\n');
    expect(extractSummaryLog(raw)).toBeNull();
  });

  it('结构非法 XML（标签不匹配 / 未闭合 / 未知元素 / 裸 <）视为不合法', () => {
    // 标签不匹配
    expect(
      extractSummaryLog('<history><user_message index="0">A</assistant></history>'),
    ).toBeNull();
    // 未闭合
    expect(extractSummaryLog('<history><user_message index="0">A</user_message>')).toBeNull();
    // 未知顶层元素类型
    expect(
      extractSummaryLog(
        '<history><user_message index="0">A</user_message><unknown>x</unknown></history>',
      ),
    ).toBeNull();
    // 文本中的裸 < / & 由解析器宽容处理（视为文本，不破坏结构）——输入侧由 XML 序列化转义兜底
    expect(
      extractSummaryLog('<history><user_message index="0">a < b & c</user_message></history>'),
    ).not.toBeNull();
  });

  it('找不到标签 / 顺序颠倒返回 null', () => {
    expect(extractSummaryLog('没有标签的纯文本')).toBeNull();
    expect(extractSummaryLog(`</${HISTORY_TAG}>\n<${HISTORY_TAG}>`)).toBeNull(); // 闭标签在开标签前
    expect(extractSummaryLog(`只有开标签 <${HISTORY_TAG}> 内容`)).toBeNull();
    expect(extractSummaryLog(`只有闭标签 </${HISTORY_TAG}>`)).toBeNull();
  });

  it('中间内容过短（< MIN_HISTORY_LENGTH）视为不合法', () => {
    expect(extractSummaryLog(block('太短'))).toBeNull();
    expect(extractSummaryLog(block(''))).toBeNull();
    expect(extractSummaryLog(`<${HISTORY_TAG}>\n   \n</${HISTORY_TAG}>`)).toBeNull(); // 空白不算
    expect(extractSummaryLog(block('<user_message index="0">\nX\n</user_message>'))).not.toBeNull(); // 合法条目（长度足够）通过
  });

  it('产物包含 <reasoning> 块视为不合法（仅作参考，输出没有）', () => {
    expect(
      extractSummaryLog(
        block('<user_message index="0">\nA\n</user_message>\n<reasoning>\n思考\n</reasoning>'),
      ),
    ).toBeNull();
    expect(
      extractSummaryLog(
        block('<user_message index="0">\nA\n</user_message>\n<reasoning>思考</reasoning>'),
      ),
    ).toBeNull();
  });

  it('index/start/end 不连续视为不合法', () => {
    expect(extractSummaryLog(block('<user_message index="0">\nA\n</user_message>'))).not.toBeNull();
    // 跳号（0 后直接 2）
    expect(
      extractSummaryLog(
        block(
          '<user_message index="0">\nA\n</user_message>\n<user_message index="2">\nC\n</user_message>',
        ),
      ),
    ).toBeNull();
    // 模块与单条重叠
    expect(
      extractSummaryLog(
        block(
          '<assistant start="0" end="1">\nM\n</assistant>\n<assistant index="1">\nX\n</assistant>',
        ),
      ),
    ).toBeNull();
  });

  it('expected 覆盖区间校验：与预期 start/end 不一致视为不合法', () => {
    const raw = block('<user_message index="0">\nA\n</user_message>');
    expect(extractSummaryLog(raw, { start: 0 })).not.toBeNull();
    expect(extractSummaryLog(raw, { start: 0, end: 0 })).not.toBeNull();
    expect(extractSummaryLog(raw, { start: 1 })).toBeNull(); // 起始 index 不符
    expect(extractSummaryLog(raw, { start: 0, end: 1 })).toBeNull(); // 覆盖区间不符
    // 非 0 起始的观察块（续接旧摘要）：expected.start = 8
    const continued = block('<user_message index="8">\nA\n</user_message>');
    expect(extractSummaryLog(continued, { start: 8, end: 8 })).not.toBeNull();
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

  /** 提取摘要指令文本（new 方式：指令在 system 字段）。 */
  function instructionText(options: ReturnType<typeof summaryOptions>): string {
    return String(options.system ?? '');
  }

  /** 返回固定观察报告的 ctx（默认 window 8：观察阈值 4 tokens，必然触发）。 */
  function observeCtx(report: string, window = 8) {
    return makeCtx({
      resolveModelInfo: async () => ({ context: { contextWindow: window } }),
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
    apply(ctx, { tailMessageCount: 0 });

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
    expect(options.maxTokens).toBe(10000); // compressMaxTokens 默认

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
    // start 携带压缩阶段（UI 压缩中提示按阶段区分文案）；首次尝试即成功 → attemptCount=1
    expect((startEvent.data as { phase?: string }).phase).toBe('observe');
    expect((summaryEvent.data as CompactionSummaryPayload).attemptCount).toBe(1);
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
    apply(ctx, { tailMessageCount: 0 });
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
    apply(ctx, { tailMessageCount: 0 });
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
    // window 11 + historyMergeRatio 3：观察阈值 1 ≤ 未压缩 6 tokens（触发）；
    // 反思阈值 33 > 旧摘要（含 tip 开标签约 26 tokens，不触发）——隔离观察路径验证增量追加
    const ctx = observeCtx(
      '<history>\n<user_message index="0">\n新内容\n</user_message>\n</history>',
      11,
    );
    apply(ctx, { tailMessageCount: 1, historyMergeRatio: 3 });
    await runPreStep(ctx, session);
    // 表层中的压缩日志消息：旧块（seq 0，保留） + 新块（独立消息，替换新消息区间）
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
    // 新块只精确替换新消息区间（seq 1 user-c1；旧块 seq 0 不在替换区间、不被遮蔽）
    const newBlock = historyMsgs[1] as unknown as {
      surfaceOp: { op: string; start: number; end: number };
      shadowedSeqs?: number[];
    };
    expect(newBlock.surfaceOp).toEqual({ op: 'replace', start: 1, end: 1 });
    expect(newBlock.shadowedSeqs).toEqual([1]);
    // 表层 = 旧块 + 新块 + 配对回退保留的 assistant/result
    expect(session.surface.nodes.length).toBe(4);
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
    apply(ctx, { tailMessageCount: 1, compressRetryCount: 2 }); // 总尝试 3 次
    await runPreStep(ctx, session);
    expect(ctx._llmCalls).toHaveLength(3); // 无输出视为失败，重试共 3 次
    // 摘要无输出：start 在摘要调用前已开启（UI 压缩中提示），end(error) 关闭生命周期；
    // 无 summary、无部分替换
    expect(session.events.some((e) => e.type === 'compaction/start')).toBe(true);
    expect(session.events.some((e) => e.type === 'compaction/summary')).toBe(false);
    const failEnd = session.events.findLast((e) => e.type === 'compaction/end');
    if (failEnd?.type !== 'compaction/end') throw new Error('缺 end');
    expect((failEnd.data as { error?: string }).error).toContain('摘要调用失败/无输出');
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
    apply(ctx, { tailMessageCount: 1, compressRetryCount: 2 }); // 总尝试 3 次
    await runPreStep(ctx, session);
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
      resolveModelInfo: async () => ({ context: { contextWindow: 8 } }),
      llmStream: {
        [Symbol.iterator]() {
          attempts += 1;
          const current = attempts;
          return (function* () {
            if (current <= 2) throw new Error(`模拟第 ${current} 次失败`);
            yield {
              type: 'text-delta',
              text: '<history>\n<user_message index="0">\nretried-ok\n</user_message>\n</history>',
            };
          })();
        },
      },
    });
    apply(ctx, { tailMessageCount: 1, compressRetryCount: 2 }); // 总尝试 3 次
    await runPreStep(ctx, session);
    expect(ctx._llmCalls).toHaveLength(3); // 首次 + 2 次重试
    expect(latestHistoryText(session)).toContain('retried-ok');
    expect(session.events.some((e) => e.type === 'compaction/start')).toBe(true);
    // start 前置（压缩中提示）且携带阶段；summary 携带成功尝试次数（第 3 次成功）
    const sIdx = session.events.findIndex((e) => e.type === 'compaction/start');
    const sEvent = session.events[sIdx];
    if (sEvent?.type !== 'compaction/start') throw new Error('缺 start');
    expect((sEvent.data as { phase?: string }).phase).toBe('observe');
    const smIdx = session.events.findIndex((e) => e.type === 'compaction/summary');
    const smEvent = session.events[smIdx];
    if (smEvent?.type !== 'compaction/summary') throw new Error('缺 summary');
    expect((smEvent.data as CompactionSummaryPayload).attemptCount).toBe(3);
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
    apply(ctx, { tailMessageCount: 1, compressRetryCount: 2 }); // 总尝试 3 次
    await runPreStep(ctx, session);
    expect(ctx._llmCalls).toHaveLength(3);
    // start 提前开启、end(error) 关闭生命周期；无 summary、无替换
    expect(session.events.some((e) => e.type === 'compaction/start')).toBe(true);
    expect(session.events.some((e) => e.type === 'compaction/end')).toBe(true);
    expect(session.events.some((e) => e.type === 'compaction/summary')).toBe(false);
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
    const ctx = observeCtx(
      '<history>\n<user_message index="0">\nOBSERVED-PASS\n</user_message>\n</history>',
    );
    apply(ctx, { tailMessageCount: 1, compressRetryCount: 2 }); // 总尝试 3 次
    await runPreStep(ctx, session);
    const steps = ctx._loggerCalls
      .filter((c) => c.level === 'debug')
      .map((c) => String(c.args[0] ?? ''));
    expect(steps.some((s) => s.includes('观察检查'))).toBe(true);
    expect(steps.some((s) => s.includes('触发压缩'))).toBe(true);
    expect(steps.some((s) => s.includes('压缩区间'))).toBe(true);
    expect(steps.some((s) => s.includes('摘要调用开始（第 1/3 次'))).toBe(true);
    expect(steps.some((s) => s.includes('摘要调用成功'))).toBe(true);
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
    apply(ctx, { tailMessageCount: 1 });
    await runPreStep(ctx, session);
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
      '<history>\n<user_message index="0">\nA-用户\n</user_message>\n<assistant start="1" end="3">\nA-模块摘要\n</assistant>\n</history>',
    );
    apply(ctx, { tailMessageCount: 1 });
    await runPreStep(ctx, session);
    // 区间 [0..5]（回退到 user-c2@5 平衡点），尾部保留 assistant-c2/result-c2
    const nodes = session.surface.nodes;
    expect(nodes.length).toBe(3); // <history> + 6,8
    expect(nodes[1]).toBe(6);
    expect(nodes[2]).toBe(8);
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
    const ctx = makeCtx({ resolveModelInfo: async () => ({ context: { contextWindow: 8 } }) });
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
    const ctx = makeCtx({ resolveModelInfo: async () => ({ context: { contextWindow: 8 } }) });
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

  it('摘要超反思阈值：摘要调用精简合并并把整个块区段替换为一条', async () => {
    // 单块摘要（X*40 + tip 标签约 26 tokens）；window 16 × 0.2 = 3 → 触发反思；
    // 表层节点数 < tailMessageCount（默认 10）→ 观察不触发
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
      llmStream: [
        {
          type: 'text-delta',
          text: '<history>\n<user_message index="0">\nREFLECTED-REPORT\n</user_message>\n</history>',
        },
      ],
    });
    apply(ctx, {});
    await runPreStep(ctx, session);
    expect(ctx._llmCalls).toHaveLength(1);
    expect(instructionText(ctx._llmCalls[0]?.options)).toBe(buildHistoryPrompt()); // 反思与观察共用同一套提示词
    expect(session.surface.nodes.length).toBe(before); // 单块区段替换，节点数不变
    expect(latestHistoryText(session)).toContain('REFLECTED');
    expect(latestHistoryText(session)).not.toContain('X'.repeat(40)); // 旧摘要被替换
  });

  it('多块反思：按全部块总长触发，把整个块区段合并为一条', async () => {
    // 两个块（各 X*40，含 tip 标签约 26 tokens，合计约 52）≥ 窗口 16 × 0.2 = 3 → 触发反思
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
      resolveModelInfo: async () => ({ context: { contextWindow: 16 } }),
      llmStream: [
        {
          type: 'text-delta',
          text: '<history>\n<user_message index="0">\nMERGED-REPORT\n</user_message>\n</history>',
        },
      ],
    });
    apply(ctx, {});
    await runPreStep(ctx, session);
    expect(ctx._llmCalls).toHaveLength(1);
    expect(instructionText(ctx._llmCalls[0]?.options)).toBe(buildHistoryPrompt()); // 反思与观察共用同一套提示词
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

  it('先反思后观察串行：反思合并旧块，观察在其后追加独立新块', async () => {
    // window 8：反思阈值 1（摘要约 13 tokens ✓），观察阈值 0（未压缩 6 tokens ✓）
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
    // 可重入迭代器：每次 stream 调用产出一个合法 <history> 块——第 1 次（反思）REFLECTED，第 2 次（观察）OBSERVED
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
                  ? '<history>\n<user_message index="0">\nREFLECTED-REPORT\n</user_message>\n</history>'
                  : '<history>\n<user_message index="0">\nOBSERVED-PASS\n</user_message>\n</history>',
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
      llmStream: [
        {
          type: 'text-delta',
          text: '<history>\n<user_message index="0">\nREFLECTED-REPORT\n</user_message>\n</history>',
        },
      ],
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
    // 反思压缩：start 携带 phase='reflect'（UI 压缩中提示按阶段区分）；首次成功 attemptCount=1
    expect((startEvent.data as { phase?: string }).phase).toBe('reflect');
    expect((summaryEvent.data as CompactionSummaryPayload).attemptCount).toBe(1);
    // 单节点替换：遮蔽区间为旧 <history> 节点
    expect(summaryEvent.data.shadowedRange).toEqual({ start: 0, end: 0 });
    expect(summaryEvent.data.shadowedSeqs).toEqual([0]);
    expect((summaryEvent.data as CompactionSummaryPayload).shadowedCharCount).toBe(40); // 旧块文本 X*40
    expect(summaryEvent.data.provider).toBe('test');
    expect(summaryEvent.data.model).toBe('test-model');
    expect(summaryEvent.data.maxTokens).toBe(10000); // compressMaxTokens 默认
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
      resolveModelInfo: async () => ({ context: { contextWindow: 11 } }),
      llmStream: [
        {
          type: 'text-delta',
          text: '<history>\n<user_message index="0">\n新内容\n</user_message>\n</history>',
        },
      ],
    });
    // historyMergeRatio 3：反思阈值 33 > 旧摘要（含 tip 开标签约 26 tokens）——隔离观察路径
    apply(ctx, { tailMessageCount: 1, historyMergeRatio: 3 });
    await runPreStep(ctx, session);
    const { start, summary } = compactionLifecycle(session);
    expect(start).not.toBe(-1);
    const summaryEvent = session.events[summary];
    if (summaryEvent?.type !== 'compaction/summary') throw new Error('缺 summary');
    const summaryText = summaryEvent.data.summary
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    expect(summaryText).toContain('新内容'); // summary = 本次观察日志
    expect(summaryText).not.toContain('旧任务'); // 不再合并旧摘要原文
    // 遮蔽数据 = 仅新消息区间（旧块 seq 0 保留、不计入遮蔽）
    expect(summaryEvent.data.shadowedRange).toEqual({ start: 1, end: 1 });
    expect(summaryEvent.data.shadowedSeqs).toEqual([1]);
    expect((summaryEvent.data as CompactionSummaryPayload).shadowedCharCount).toBe(9); // 遮蔽仅新 user 消息「请帮我完成一个任务」
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
          text: '<history>\n<user_message index="0">\n请帮我完成一个任务\n</user_message>\n</history>',
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
  async function runPreStep(ctx: ReturnType<typeof makeCtx>, session: Session) {
    const preStepListeners = ctx._onCallbacks.get('agent/pre-step');
    await preStepListeners?.[0]?.(
      { agent: { session }, signal: new AbortController().signal },
      () => {},
    );
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
      resolveModelInfo: async () => ({ context: { contextWindow: 8 } }),
      llmStream: [
        {
          type: 'text-delta',
          text: '<history>\n<user_message index="0">\nOBSERVED-PASS\n</user_message>\n</history>',
        },
      ],
    });
    apply(ctx, { tailMessageCount: 1 });
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
    // 输入 = 被压缩区间 [0]（tailCount=1 配对回退）的完整消息渲染（合法 <history> 块，带绝对 index），不含分段标签与尾部
    expect(input).toContain('<history>');
    expect(input).toContain('<user_message index="0">');
    expect(input).toContain('请帮我完成一个任务');
    expect(input).not.toContain('【被压缩消息】');
    expect(input).not.toContain('【参考尾部】');
    expect(input).not.toContain('message_id=user-c1'); // 不用 message_id
    expect(session.surface.nodes.length).toBe(3); // <history> + 尾部 assistant + result
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
    // 输入输出都是合法的 <history> 块
    expect(text.startsWith('<history>\n')).toBe(true);
    expect(text.endsWith('\n</history>')).toBe(true);
    // 用户消息 → <user_message index="0">（原文完整保留，仅文本）
    expect(text).toContain('<user_message index="0">');
    expect(text).toContain('请帮我完成一个任务');
    expect(text).toContain('</user_message>');
    // 文本与 toolcall 拆开：文本 index=1，toolcall（调用+结果）index=2（内容原样）
    expect(text).toContain('<assistant index="1">');
    expect(text).toContain('我来执行代码');
    expect(text).toContain('<assistant index="2">');
    expect(text).toContain('[tool-call run_code id=c1]');
    expect(text).toContain('r1');
    expect(text).toContain('[result]');
    expect(text).not.toContain('message_id');
  });

  it('用户消息图片/文件块以注释补充（文本原样），assistant reasoning 输出 <reasoning> 参考条目', () => {
    const events = [
      {
        type: 'user/message',
        data: makeMessage({
          content: [
            textBlock('看图说话'),
            {
              type: 'image',
              attachment: {
                attachmentId: 'att-1',
                mediaType: 'image/png',
                bytes: 1024,
                width: 800,
                height: 600,
                name: '图.png',
              },
            },
            { type: 'file', name: 'a.txt' } as never, // 未知块类型走通用注释
          ],
          id: 'u-img',
        }),
      } as unknown as SessionEvent,
      {
        type: 'assistant/message',
        data: {
          message: makeMessage({
            role: 'assistant',
            content: [{ type: 'reasoning', text: '先看图再回答' }, textBlock('这是答案')],
            source: { kind: 'model', provider: 'test', model: 'test-model' },
            id: 'a-think',
          }),
        },
      } as unknown as SessionEvent,
    ];
    const session = makeSession({ events });
    const text = renderMessages(session, [0, 1]);
    // 用户消息：文本原样 + 图片注释（名称/媒体类型/尺寸/字节数）+ 通用块注释
    expect(text).toContain('<user_message index="0">');
    expect(text).toContain('看图说话');
    expect(text).toContain('<!-- 图片附件：图.png（image/png 800×600，1024 bytes） -->');
    expect(text).toContain('<!-- file 块 -->');
    // reasoning 参考条目（产物中没有，但输入保留；DOM 序列化紧凑、文本自动转义）；assistant 文本原样
    expect(text).toContain('<reasoning>先看图再回答</reasoning>');
    expect(text).toContain('<assistant index="1">');
    expect(text).toContain('这是答案');
    // reasoning 不是完整消息：不占 index（assistant 文本仍为 index 1）
    expect(text).toContain('<user_message index="0">');
    expect(text).toContain('<assistant index="1">');
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
    expect(text.startsWith('<history>\n')).toBe(true);
    expect(text).toContain('<user_message index="0">');
    expect(text).toContain('你好');
    expect(text).toContain('<user_message index="1">');
    expect(text).toContain('再见');
    expect(text).not.toContain('区间外'); // 不在遮蔽集合内
  });

  it('用户消息中的 <system-reminder> 文本按普通文本转义（不再特殊保留）', () => {
    const reminder = [
      '<system-reminder>',
      'The following workspace instructions may be relevant.',
      'Instructions from: AGENTS.md',
      '</system-reminder>',
    ].join('\n');
    const session = makeSession({
      events: [
        {
          type: 'user/message',
          data: makeMessage({ content: [textBlock(`我的问题\n${reminder}\n请继续`)], id: 'u-sr' }),
        } as unknown as SessionEvent,
      ],
    });
    const text = renderMessages(session, [0]);
    // 标签转义为实体，内容文本原样（普通字符不转义）
    expect(text).toContain('&lt;system-reminder&gt;');
    expect(text).toContain('The following workspace instructions may be relevant.');
    expect(text).toContain('Instructions from: AGENTS.md');
    expect(text).toContain('&lt;/system-reminder&gt;');
    expect(text).not.toContain('<system-reminder>');
    // 块外文本原样保留
    expect(text).toContain('我的问题');
    expect(text).toContain('请继续');
  });

  it('含 <system-reminder> 标签的残缺/非法文本也整体转义（统一按文本处理）', () => {
    const noClose = makeSession({
      events: [
        {
          type: 'user/message',
          data: makeMessage({
            content: [textBlock('<system-reminder>no closing')],
            id: 'u-sr1',
          }),
        } as unknown as SessionEvent,
      ],
    });
    expect(renderMessages(noClose, [0])).toContain('&lt;system-reminder&gt;no closing');
    const invalidContent = makeSession({
      events: [
        {
          type: 'user/message',
          data: makeMessage({
            content: [textBlock('<system-reminder><inner></system-reminder>')],
            id: 'u-sr2',
          }),
        } as unknown as SessionEvent,
      ],
    });
    expect(renderMessages(invalidContent, [0])).toContain(
      '&lt;system-reminder&gt;&lt;inner&gt;&lt;/system-reminder&gt;',
    );
  });
});

describe('系统消息渲染（<sys> 空块）', () => {
  it('非 kind:user 的 user_message 渲染为 <sys type="KIND" index="N"></sys> 空块，内容不进入输入', () => {
    const session = makeSession({
      events: [
        {
          type: 'user/message',
          data: makeMessage({
            content: [textBlock('宿主注入的工作区指令，内容很长不需要进入压缩输入')],
            source: { kind: 'agent-instructions' },
            id: 's1',
          }),
        } as unknown as SessionEvent,
        {
          type: 'user/message',
          data: makeMessage({ content: [textBlock('真正的用户消息')], id: 'u1' }),
        } as unknown as SessionEvent,
      ],
    });
    const text = renderMessages(session, [0, 1]);
    // sys 空块：type=source.kind、index=完整消息序号；用户消息照常渲染
    expect(text).toContain('<sys type="agent-instructions" index="0"></sys>');
    expect(text).toContain('<user_message index="1">');
    expect(text).toContain('真正的用户消息');
    // 系统消息内容不进入压缩输入
    expect(text).not.toContain('宿主注入的工作区指令');
  });

  it('无 source.kind 的 user_message 归为系统消息，渲染为 <sys type="" index="N"></sys>', () => {
    const session = makeSession({
      events: [
        {
          type: 'user/message',
          data: { id: 's0', role: 'user', content: [textBlock('x')] },
        } as unknown as SessionEvent,
      ],
    });
    expect(renderMessages(session, [0])).toContain('<sys type="" index="0"></sys>');
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

  it('系统消息（sys）参与 index 并显示原文', async () => {
    const session = makeSession({
      events: [
        {
          type: 'user/message',
          data: makeMessage({
            content: [textBlock('宿主注入的工作区指令')],
            source: { kind: 'agent-instructions' },
            id: 'sys-inst',
          }),
        } as unknown as SessionEvent,
        ...twoCallFlow(),
      ],
    });
    const tool = buildRecallTool();
    const exec = { agent: { session } };
    // sys 占 index 0，后续两条流程从 index 1 起
    const span = await tool.execute({ start: 0, end: 6 }, exec as never);
    expect(String(span)).toContain('-- [index 0] sys --');
    expect(String(span)).toContain('宿主注入的工作区指令'); // sys 显示原文
    expect(String(span)).toContain('-- [index 1] user --');
    expect(String(span)).toContain('-- [index 6] toolcall callId=c2 --');
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
    expect(out).toContain(SEMANTIC_MODEL_NOT_READY_MESSAGE);
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
