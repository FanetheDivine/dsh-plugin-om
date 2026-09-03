// 客户端压缩卡片定义测试：检查点认领、生命周期匹配与节点构建。
// 事件 fixture 直接构造宿主 SessionEvent（运行时事件流），与插件服务端写入的
// compaction/* 载荷字段保持一致（shadowedSeqs/shadowedTokenCount/summary ContentBlock）。

import type {
  ConversationMatch,
  ConversationNodeContext,
} from '@deepseek-ai/dsh-client-runtime/client';
import type { SessionEvent } from '@deepseek-ai/dsh-session/types';
import { describe, expect, it } from 'vitest';
import {
  COMPACTION_CARD_KIND,
  checkpointCompactionId,
  omCompactionDefinition,
} from '../../src/client/definition.ts';
import { COMPACTION_ABORTED_ERROR, PLUGIN_LABEL } from '../../src/constants.ts';

/** 宿主 compaction-basic 的检查点标记：宿主自己渲染，插件不认领。 */
const HOST_COMPACT_PLUGIN = 'compact';

function checkpointEvent(seq: number, source: unknown): SessionEvent {
  return {
    type: 'user/message',
    seq,
    time: 1000 + seq,
    surfaceOp: { op: 'replace', start: seq - 2, end: seq - 1 },
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
  return { event, role, view: undefined, location: { kind: 'unresolved' } };
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
    const source = { kind: 'plugin', plugin: PLUGIN_LABEL, compactionId: 'om-1' };
    expect(checkpointCompactionId(checkpointEvent(10, source))).toBe('om-1');
  });

  it('忽略宿主 compact 检查点（由宿主自己渲染，避免双卡片）', () => {
    const source = { kind: 'plugin', plugin: HOST_COMPACT_PLUGIN, compactionId: 'x' };
    expect(checkpointCompactionId(checkpointEvent(10, source))).toBeUndefined();
  });

  it('忽略 append 来源消息', () => {
    const source = { kind: 'plugin', plugin: PLUGIN_LABEL, compactionId: 'om-1' };
    expect(checkpointCompactionId(appendEvent(10, source))).toBeUndefined();
  });

  it('忽略缺失或非法的标记', () => {
    expect(checkpointCompactionId(checkpointEvent(10, undefined))).toBeUndefined();
    expect(
      checkpointCompactionId(checkpointEvent(10, { kind: 'plugin', plugin: PLUGIN_LABEL })),
    ).toBeUndefined();
    expect(
      checkpointCompactionId(
        checkpointEvent(10, { kind: 'plugin', plugin: 'other', compactionId: 'x' }),
      ),
    ).toBeUndefined();
    expect(
      checkpointCompactionId(
        checkpointEvent(10, { kind: 'message', plugin: PLUGIN_LABEL, compactionId: 'x' }),
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
      kind: 'plugin',
      plugin: PLUGIN_LABEL,
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
    const hostCheckpoint = checkpointEvent(8, {
      kind: 'plugin',
      plugin: HOST_COMPACT_PLUGIN,
      compactionId: 'x',
    });
    expect(omCompactionDefinition.match(hostCheckpoint)).toBeNull();
  });
});

describe('omCompactionDefinition.update', () => {
  it('折叠 summary 与检查点证据', () => {
    const summary = matchOf(lifecycle('compaction/summary', 6, { compactionId: 'om-1' }));
    const checkpoint = matchOf(
      checkpointEvent(8, { kind: 'plugin', plugin: PLUGIN_LABEL, compactionId: 'om-1' }),
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
    checkpointEvent(8, { kind: 'plugin', plugin: PLUGIN_LABEL, compactionId: 'om-1' }),
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
        attemptCount: 0, // 首次尝试即成功（载荷 attemptCount 即重试次数）
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
        running: false,
        phase: null,
        retryCount: 0, // 首次尝试即成功
      },
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
        retryCount: null,
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
        retryCount: null,
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

  it('summary 载荷 attemptCount 3 → retryCount 3', () => {
    const summary = matchOf(
      lifecycle('compaction/summary', 6, {
        compactionId: 'om-1',
        summary: [{ type: 'text', text: '重试后成功' }],
        shadowedSeqs: [1],
        shadowedTokenCount: 9,
        shadowedCharCount: 88,
        attemptCount: 3,
      }),
    );
    const state = { summary, checkpoint };
    const node = omCompactionDefinition.buildViewNode?.(contextOf([summary, checkpoint], state));
    expect(node).not.toBeNull();
    expect(node?.data).toMatchObject({
      retryCount: 3,
      running: false,
      phase: null,
    });
  });

  it('旧载荷无 attemptCount（首版插件）时 retryCount 为 null', () => {
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
    expect(node?.data).toMatchObject({ retryCount: null });
  });
});
