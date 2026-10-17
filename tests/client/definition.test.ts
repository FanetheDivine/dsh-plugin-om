// 客户端压缩卡片定义测试：检查点认领、生命周期匹配与节点构建。
// 事件 fixture 直接构造宿主 SessionEvent（运行时事件流），与插件服务端写入的
// compaction/* 载荷字段保持一致（shadowedSeqs/shadowedTokenCount/summary ContentBlock）。

import type {
  ConversationMatch,
  ConversationNodeContext,
} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { SessionEvent } from '@deepseek-ai/dsh-session/types';
import { describe, expect, it } from 'vitest';
import {
  COMPACTION_CARD_KIND,
  checkpointCompactionId,
  OM_WARNING_CARD_KIND,
  omCompactionDefinition,
  omWarningDefinition,
} from '../../src/client/definition.ts';
import { COMPACTION_ABORTED_ERROR, PLUGIN_SOURCE_KIND } from '../../src/constants.ts';

/** 宿主 compaction-basic 的检查点 source：宿主自己渲染，插件不认领。 */
const HOST_CHECKPOINT_SOURCE = { kind: 'compact-checkpoint', compactionId: 'x' } as const;

function checkpointEvent(seq: number, source: unknown): SessionEvent {
  return {
    type: 'user/message',
    seq,
    time: 1000 + seq,
    surfaceOp: { op: 'replace', startSeq: seq - 2, endSeq: seq - 1 },
    data: { source },
  } as unknown as SessionEvent;
}

function appendEvent(seq: number, source?: unknown): SessionEvent {
  return {
    type: 'user/message',
    seq,
    time: 1000 + seq,
    surfaceOp: 'append',
    data: {
      surface: { op: 'append' },
      ...(source === undefined ? {} : { source }),
    },
  } as unknown as SessionEvent;
}

function lifecycle(
  type: 'compaction/start' | 'compaction/summary' | 'compaction/end',
  seq: number,
  data: Record<string, unknown>,
): SessionEvent {
  return { type, seq, time: 1000 + seq, data } as unknown as SessionEvent;
}

function matchOf(event: SessionEvent, role: 'start' | 'update' = 'update'): ConversationMatch {
  return { event, role, location: { kind: 'unresolved' } };
}

function contextOf(
  matches: ConversationMatch[],
  state?: Record<string, unknown>,
): ConversationNodeContext<Record<string, unknown>> {
  return {
    key: `ctx:${matches[0]?.event.seq ?? 0}`,
    kind: COMPACTION_CARD_KIND,
    id: 'om:1',
    matches,
    start: matches.find((match) => match.role === 'start'),
    state,
    current: new Map(),
  };
}

describe('checkpointCompactionId', () => {
  it('识别插件自产的替换检查点', () => {
    const source = { kind: PLUGIN_SOURCE_KIND, compactionId: 'om-1' };
    expect(checkpointCompactionId(checkpointEvent(10, source))).toBe('om-1');
  });

  it('忽略宿主 compact 检查点（由宿主自己渲染，避免双卡片）', () => {
    expect(checkpointCompactionId(checkpointEvent(10, HOST_CHECKPOINT_SOURCE))).toBeUndefined();
  });

  it('忽略 append 来源消息', () => {
    const source = { kind: PLUGIN_SOURCE_KIND, compactionId: 'om-1' };
    expect(checkpointCompactionId(appendEvent(10, source))).toBeUndefined();
  });

  it('忽略缺失或非法的标记', () => {
    expect(checkpointCompactionId(checkpointEvent(10, undefined))).toBeUndefined();
    expect(
      checkpointCompactionId(checkpointEvent(10, { kind: PLUGIN_SOURCE_KIND })),
    ).toBeUndefined();
    expect(
      checkpointCompactionId(
        checkpointEvent(10, { kind: 'plugin:other-plugin', compactionId: 'x' }),
      ),
    ).toBeUndefined();
    expect(
      checkpointCompactionId(checkpointEvent(10, { kind: 'message', compactionId: 'x' })),
    ).toBeUndefined();
    // 宿主迁移前的 v3 信封形态（kind 'plugin' + plugin 字段）不经宿主迁移到达客户端，不认领
    expect(
      checkpointCompactionId(
        checkpointEvent(10, { kind: 'plugin', plugin: 'dsh-plugin-om', compactionId: 'om-1' }),
      ),
    ).toBeUndefined();
  });
});

describe('omCompactionDefinition.match', () => {
  it('以 compaction/start 开启上下文', () => {
    expect(
      omCompactionDefinition.match(
        lifecycle('compaction/start', 5, { compactionId: 'om-1', turn: 1 }),
      ),
    ).toEqual({ id: 'om-1', role: 'start' });
  });

  it('summary/end 作为 update', () => {
    expect(
      omCompactionDefinition.match(lifecycle('compaction/summary', 6, { compactionId: 'om-1' })),
    ).toEqual({ id: 'om-1', role: 'update' });
    expect(
      omCompactionDefinition.match(lifecycle('compaction/end', 9, { compactionId: 'om-1' })),
    ).toEqual({ id: 'om-1', role: 'update' });
  });

  it('拒绝空或非字符串 compactionId', () => {
    expect(
      omCompactionDefinition.match(lifecycle('compaction/start', 5, { compactionId: '' })),
    ).toBeNull();
    expect(
      omCompactionDefinition.match(lifecycle('compaction/start', 5, { compactionId: 7 })),
    ).toBeNull();
  });

  it('认领插件检查点为 update（压缩中段进入窗口时仍能折叠证据）', () => {
    const event = checkpointEvent(8, {
      kind: PLUGIN_SOURCE_KIND,
      compactionId: 'om-1',
    });
    expect(omCompactionDefinition.match(event)).toEqual({ id: 'om-1', role: 'update' });
  });

  it('忽略无关事件与宿主检查点', () => {
    const plain = {
      type: 'user/message',
      seq: 1,
      time: 1001,
      data: { content: 'hi' },
    } as unknown as SessionEvent;
    expect(omCompactionDefinition.match(plain)).toBeNull();
    const hostCheckpoint = checkpointEvent(8, HOST_CHECKPOINT_SOURCE);
    expect(omCompactionDefinition.match(hostCheckpoint)).toBeNull();
  });
});

describe('omCompactionDefinition.update', () => {
  it('折叠 summary 与检查点证据', () => {
    const summary = matchOf(lifecycle('compaction/summary', 6, { compactionId: 'om-1' }));
    const checkpoint = matchOf(
      checkpointEvent(8, { kind: PLUGIN_SOURCE_KIND, compactionId: 'om-1' }),
    );
    const afterSummary = omCompactionDefinition.update({ ...contextOf([]), state: {} }, summary);
    expect(afterSummary).toEqual({ summary });
    const afterCheckpoint = omCompactionDefinition.update(
      { ...contextOf([]), state: afterSummary },
      checkpoint,
    );
    expect(afterCheckpoint).toEqual({ summary, checkpoint });
  });

  it('折叠 compaction/end 证据（压缩失败时撤回提示行）', () => {
    const end = matchOf(
      lifecycle('compaction/end', 9, { compactionId: 'om-1', error: '摘要调用失败/无输出' }),
    );
    const after = omCompactionDefinition.update({ ...contextOf([]), state: {} }, end);
    expect(after).toEqual({ end });
  });
});

describe('omCompactionDefinition.buildViewNode', () => {
  const checkpoint = matchOf(
    checkpointEvent(8, { kind: PLUGIN_SOURCE_KIND, compactionId: 'om-1' }),
  );

  it('无检查点时不产出节点', () => {
    const summary = matchOf(
      lifecycle('compaction/summary', 6, {
        compactionId: 'om-1',
        summary: [],
        shadowedSeqs: [],
        shadowedTokenCount: 0,
        shadowedCharCount: 0,
      }),
    );
    expect(omCompactionDefinition.buildViewNode?.(contextOf([summary], { summary }))).toBeNull();
  });

  it('渲染 summary 文本与遮蔽统计', () => {
    const summary = matchOf(
      lifecycle('compaction/summary', 6, {
        compactionId: 'om-1',
        summary: [{ type: 'text', text: '观察：模型停顿。反思：建议简化。' }],
        shadowedSeqs: [2, 3, 4],
        shadowedTokenCount: 1234,
        shadowedCharCount: 5000,
        provider: 'alt',
        model: 'big-1',
        reasoningEffort: 'high',
        durationMs: 63100,
      }),
    );
    const state = { summary, checkpoint };
    const node = omCompactionDefinition.buildViewNode?.(contextOf([summary, checkpoint], state));
    expect(node).not.toBeNull();
    expect(node).toMatchObject({
      key: 'ctx:6',
      kind: 'om-compaction',
      target: 'chat',
      anchorSeq: 8,
      data: {
        summary: '观察：模型停顿。反思：建议简化。',
        summaryEventSeq: 6,
        shadowedItemCount: 3,
        shadowedTokenCount: 1234,
        shadowedCharCount: 5000,
        summaryCharCount: 16,
        summaryTokenCount: 4,
        provider: 'alt',
        model: 'big-1',
        reasoningEffort: 'high',
        durationMs: 63100,
        running: false,
        phase: null,
      },
    });
  });

  it('模型与耗时缺失或非法时回落 null', () => {
    const summary = matchOf(
      lifecycle('compaction/summary', 6, {
        compactionId: 'om-1',
        summary: [{ type: 'text', text: '摘要' }],
        shadowedSeqs: [2],
        shadowedTokenCount: 10,
        shadowedCharCount: 40,
        provider: '',
        model: 7,
        reasoningEffort: null,
        durationMs: -1,
      }),
    );
    const node = omCompactionDefinition.buildViewNode?.(
      contextOf([summary, checkpoint], { summary, checkpoint }),
    );
    expect(node).toMatchObject({
      data: { provider: null, model: null, reasoningEffort: null, durationMs: null },
    });
  });

  it('summary 事件在窗外时不可展开（各字段为 null）', () => {
    const node = omCompactionDefinition.buildViewNode?.(contextOf([checkpoint], { checkpoint }));
    expect(node).toMatchObject({
      kind: 'om-compaction',
      anchorSeq: 8,
      data: {
        summary: null,
        summaryEventSeq: null,
        shadowedItemCount: null,
        shadowedTokenCount: null,
        shadowedCharCount: null,
        summaryCharCount: null,
        summaryTokenCount: null,
        provider: null,
        model: null,
        reasoningEffort: null,
        durationMs: null,
      },
    });
  });

  it('state 缺失时回落到证据扫描', () => {
    const summary = matchOf(
      lifecycle('compaction/summary', 6, {
        compactionId: 'om-1',
        summary: [{ type: 'text', text: 's' }],
        shadowedSeqs: [1],
        shadowedTokenCount: 9,
        shadowedCharCount: 88,
      }),
    );
    const node = omCompactionDefinition.buildViewNode?.(contextOf([summary, checkpoint]));
    expect(node).not.toBeNull();
    expect(node?.data).toMatchObject({
      summary: 's',
      shadowedItemCount: 1,
      shadowedTokenCount: 9,
      shadowedCharCount: 88,
      summaryCharCount: 1,
      summaryTokenCount: 1,
    });
  });

  it('空文本与非法的统计字段回落为 null', () => {
    const summary = matchOf(
      lifecycle('compaction/summary', 6, {
        compactionId: 'om-1',
        summary: [{ type: 'text', text: '   ' }],
        shadowedSeqs: [1, -2],
        shadowedTokenCount: -1,
        shadowedCharCount: -3,
      }),
    );
    const state = { summary, checkpoint };
    const node = omCompactionDefinition.buildViewNode?.(contextOf([summary, checkpoint], state));
    expect(node?.data).toMatchObject({
      summary: null,
      shadowedItemCount: null,
      shadowedTokenCount: null,
      shadowedCharCount: null,
      summaryCharCount: null,
      summaryTokenCount: null,
    });
  });

  it('旧载荷无 shadowedCharCount 时该字段回落为 null（其余统计保留）', () => {
    const summary = matchOf(
      lifecycle('compaction/summary', 6, {
        compactionId: 'om-1',
        summary: [{ type: 'text', text: '旧版摘要' }],
        shadowedSeqs: [1, 2],
        shadowedTokenCount: 42,
      }),
    );
    const state = { summary, checkpoint };
    const node = omCompactionDefinition.buildViewNode?.(contextOf([summary, checkpoint], state));
    expect(node?.data).toMatchObject({
      summary: '旧版摘要',
      shadowedItemCount: 2,
      shadowedTokenCount: 42,
      shadowedCharCount: null,
      summaryCharCount: 4,
      summaryTokenCount: 1,
    });
  });

  it('start 已到、checkpoint/end 未到：渲染压缩中提示行（running + phase）', () => {
    const start = matchOf(
      lifecycle('compaction/start', 5, { compactionId: 'om-1', turn: 1, phase: 'observe' }),
      'start',
    );
    const node = omCompactionDefinition.buildViewNode?.(contextOf([start], {}));
    expect(node).not.toBeNull();
    expect(node).toMatchObject({
      kind: 'om-compaction',
      target: 'chat',
      anchorSeq: 5,
      visibility: 'visible',
      data: {
        running: true,
        phase: 'observe',
        summary: null,
        summaryEventSeq: null,
        shadowedItemCount: null,
        shadowedTokenCount: null,
        shadowedCharCount: null,
        summaryCharCount: null,
        summaryTokenCount: null,
      },
    });
  });

  it('start 载荷缺 phase（旧版本会话）时 phase 回落为 null', () => {
    const start = matchOf(
      lifecycle('compaction/start', 5, { compactionId: 'om-1', turn: 1 }),
      'start',
    );
    const node = omCompactionDefinition.buildViewNode?.(contextOf([start], {}));
    expect(node?.data).toMatchObject({ running: true, phase: null });
  });

  it('end error 以中止标识开头（用户中止）：以 hidden visibility 撤回提示行', () => {
    const start = matchOf(
      lifecycle('compaction/start', 5, { compactionId: 'om-1', turn: 1, phase: 'reflect' }),
      'start',
    );
    const end = matchOf(
      lifecycle('compaction/end', 9, {
        compactionId: 'om-1',
        error: COMPACTION_ABORTED_ERROR,
      }),
    );
    const state = { end };
    const node = omCompactionDefinition.buildViewNode?.(contextOf([start, end], state));
    expect(node).not.toBeNull();
    expect(node).toMatchObject({
      kind: 'om-compaction',
      anchorSeq: 5,
      visibility: 'hidden',
      data: { running: true, phase: 'reflect', error: null },
    });
  });

  it('end 带非中止 error（压缩失败）：渲染可见失败行（error + running false + phase）', () => {
    const start = matchOf(
      lifecycle('compaction/start', 5, { compactionId: 'om-1', turn: 1, phase: 'observe' }),
      'start',
    );
    const end = matchOf(
      lifecycle('compaction/end', 9, { compactionId: 'om-1', error: 'LLM 429 Too Many Requests' }),
    );
    const state = { end };
    const node = omCompactionDefinition.buildViewNode?.(contextOf([start, end], state));
    expect(node).not.toBeNull();
    expect(node).toMatchObject({
      kind: 'om-compaction',
      anchorSeq: 5,
      visibility: 'visible',
      data: {
        running: false,
        phase: 'observe',
        error: 'LLM 429 Too Many Requests',
        summary: null,
        summaryEventSeq: null,
        shadowedItemCount: null,
        shadowedTokenCount: null,
        shadowedCharCount: null,
        summaryCharCount: null,
        summaryTokenCount: null,
      },
    });
  });

  it('end 无 error（旧版本会话）：维持 hidden 撤回提示行', () => {
    const start = matchOf(
      lifecycle('compaction/start', 5, { compactionId: 'om-1', turn: 1 }),
      'start',
    );
    const end = matchOf(lifecycle('compaction/end', 9, { compactionId: 'om-1' }));
    const state = { end };
    const node = omCompactionDefinition.buildViewNode?.(contextOf([start, end], state));
    expect(node).not.toBeNull();
    expect(node).toMatchObject({
      kind: 'om-compaction',
      anchorSeq: 5,
      visibility: 'hidden',
      data: { running: true, error: null },
    });
  });

  it('summary 载荷含压缩计时字段（startedAt/completedAt/durationMs）时节点正常构建（字段不进 UI 数据）', () => {
    const summary = matchOf(
      lifecycle('compaction/summary', 6, {
        compactionId: 'om-1',
        summary: [{ type: 'text', text: '重试后成功' }],
        shadowedSeqs: [1],
        shadowedTokenCount: 9,
        shadowedCharCount: 88,
        startedAt: 1000,
        completedAt: 9000,
        durationMs: 8000,
      }),
    );
    const state = { summary, checkpoint };
    const node = omCompactionDefinition.buildViewNode?.(contextOf([summary, checkpoint], state));
    expect(node).not.toBeNull();
    expect(node?.data).toMatchObject({
      summary: '重试后成功',
      shadowedTokenCount: 9,
      running: false,
      phase: null,
    });
  });
});
describe('omCompactionDefinition 诊断子会话 id', () => {
  const checkpoint = matchOf(
    checkpointEvent(8, { kind: PLUGIN_SOURCE_KIND, compactionId: 'om-1' }),
  );

  function summaryWith(extra: Record<string, unknown>): ConversationMatch {
    return matchOf(
      lifecycle('compaction/summary', 6, {
        compactionId: 'om-1',
        summary: [{ type: 'text', text: 's' }],
        shadowedSeqs: [1],
        shadowedTokenCount: 9,
        shadowedCharCount: 88,
        ...extra,
      }),
    );
  }

  function endWith(extra: Record<string, unknown>): ConversationMatch {
    return matchOf(lifecycle('compaction/end', 9, { compactionId: 'om-1', ...extra }));
  }

  function build(state: Record<string, ConversationMatch>, matches: ConversationMatch[]) {
    return omCompactionDefinition.buildViewNode?.(contextOf(matches, state));
  }

  it('成功卡片读取 summary 载荷的 diagnosticSessionId', () => {
    const summary = summaryWith({ diagnosticSessionId: 'diag-1' });
    const node = build({ summary, checkpoint }, [summary, checkpoint]);
    expect(node?.data).toMatchObject({ diagnosticSessionId: 'diag-1' });
  });

  it('summary 缺失时回落 compaction/end 载荷的 diagnosticSessionId', () => {
    const end = endWith({ diagnosticSessionId: 'diag-end' });
    const node = build({ checkpoint, end }, [checkpoint, end]);
    expect(node?.data).toMatchObject({ diagnosticSessionId: 'diag-end' });
  });

  it('summary 与 end 同时带 id 时 summary 优先', () => {
    const summary = summaryWith({ diagnosticSessionId: 'diag-summary' });
    const end = endWith({ diagnosticSessionId: 'diag-end' });
    const node = build({ summary, checkpoint, end }, [summary, checkpoint, end]);
    expect(node?.data).toMatchObject({ diagnosticSessionId: 'diag-summary' });
  });

  it('失败行读取 compaction/end 载荷的 diagnosticSessionId', () => {
    const start = matchOf(
      lifecycle('compaction/start', 5, { compactionId: 'om-1', turn: 1, phase: 'observe' }),
      'start',
    );
    const end = endWith({ error: 'LLM 429', diagnosticSessionId: 'diag-fail' });
    const node = omCompactionDefinition.buildViewNode?.(contextOf([start, end], { end }));
    expect(node?.data).toMatchObject({ error: 'LLM 429', diagnosticSessionId: 'diag-fail' });
  });

  it('缺失、空串或非字符串的 id 回落为 null', () => {
    for (const value of [undefined, '', 42, { id: 'x' }]) {
      const summary = summaryWith(value === undefined ? {} : { diagnosticSessionId: value });
      const node = build({ summary, checkpoint }, [summary, checkpoint]);
      expect(node?.data).toMatchObject({ diagnosticSessionId: null });
    }
  });

  it('进行中提示行与窗外 summary 的 id 为 null', () => {
    const start = matchOf(
      lifecycle('compaction/start', 5, { compactionId: 'om-1', turn: 1 }),
      'start',
    );
    expect(omCompactionDefinition.buildViewNode?.(contextOf([start]))?.data).toMatchObject({
      diagnosticSessionId: null,
    });
    expect(build({ checkpoint }, [checkpoint])?.data).toMatchObject({
      diagnosticSessionId: null,
    });
  });
});

describe('omCompactionDefinition 压缩 id', () => {
  it('成功、失败与进行中节点都携带 context.id 作为 compactionId', () => {
    const checkpoint = matchOf(
      checkpointEvent(8, { kind: PLUGIN_SOURCE_KIND, compactionId: 'om:1' }),
    );
    const start = matchOf(
      lifecycle('compaction/start', 5, { compactionId: 'om:1', turn: 1, phase: 'observe' }),
      'start',
    );
    const end = matchOf(lifecycle('compaction/end', 9, { compactionId: 'om:1', error: 'LLM 429' }));
    const success = omCompactionDefinition.buildViewNode?.(contextOf([checkpoint], { checkpoint }));
    const failed = omCompactionDefinition.buildViewNode?.(contextOf([start, end], { end }));
    const running = omCompactionDefinition.buildViewNode?.(contextOf([start]));
    for (const node of [success, failed, running]) {
      expect(node?.data).toMatchObject({ compactionId: 'om:1' });
    }
  });
});

describe('omWarningDefinition（om/warning 记录的功能降级警告行）', () => {
  /** 构造 om/warning plugin record 事件。 */
  function warningEvent(seq: number, data: unknown): SessionEvent {
    return {
      type: 'plugin:dsh-plugin-om/warning',
      seq,
      time: 2000 + seq,
      data,
      ignorable: true,
    } as unknown as SessionEvent;
  }

  it('match 认领 om/warning 记录为 start（id 含 seq，逐条独立节点）', () => {
    expect(omWarningDefinition.match(warningEvent(7, { problem: 'p', message: 'm' }))).toEqual({
      id: 'om-warning:7',
      role: 'start',
    });
  });

  it('忽略非 om 记录（其他类型 / 未标 ignorable 的同名事件 / 载荷非法）', () => {
    const plain = {
      type: 'user/message',
      seq: 1,
      time: 2001,
      data: { content: 'hi' },
    } as unknown as SessionEvent;
    expect(omWarningDefinition.match(plain)).toBeNull();
    const notIgnorable = {
      type: 'plugin:dsh-plugin-om/warning',
      seq: 2,
      time: 2002,
      data: { problem: 'p', message: 'm' },
    } as unknown as SessionEvent;
    expect(omWarningDefinition.match(notIgnorable)).toBeNull();
    const legacyEnvelope = {
      type: 'feedback/record',
      seq: 4,
      time: 2004,
      data: { text: `om:1:${JSON.stringify({ kind: 'om/warning', problem: 'p', message: 'm' })}` },
    } as unknown as SessionEvent;
    expect(omWarningDefinition.match(legacyEnvelope)).toBeNull();
    expect(omWarningDefinition.match(warningEvent(3, { problem: 'p' }))).toBeNull(); // 缺 message
  });

  it('渲染 problem 与 message（锚定事件自身 seq）', () => {
    const start = matchOf(
      warningEvent(7, { problem: 'systemPrompt-missing', message: '系统提示词服务未挂载' }),
      'start',
    );
    const node = omWarningDefinition.buildViewNode?.(contextOf([start], {}));
    expect(node).toMatchObject({
      kind: OM_WARNING_CARD_KIND,
      target: 'chat',
      anchorSeq: 7,
      visibility: 'visible',
      data: { problem: 'systemPrompt-missing', message: '系统提示词服务未挂载' },
    });
  });

  it('message 为空串回落 null；problem/message 皆空时不产出节点', () => {
    const start = matchOf(warningEvent(7, { problem: 'p', message: '' }), 'start');
    expect(omWarningDefinition.buildViewNode?.(contextOf([start], {}))).toMatchObject({
      data: { problem: 'p', message: null },
    });
    const empty = matchOf(warningEvent(8, { problem: '', message: '' }), 'start');
    expect(omWarningDefinition.buildViewNode?.(contextOf([empty], {}))).toBeNull();
  });
});
