// log-index.ts 单元测试：会话日志索引与呈现 —— indexMessages / messageIdOfEvent /
// indexCompleteMessages / renderCompleteMessage / renderToolResultText。
import { describe, expect, it } from 'vitest';

import {
  indexCompleteMessages,
  indexMessages,
  messageIdOfEvent,
  renderCompleteMessage,
  renderToolResultText,
} from '../src/log-index.ts';
import type { SessionEvent } from '../src/types.ts';
import {
  buildToolCallFlow,
  historyMessage,
  makeMessage,
  makeSession,
  textBlock,
  toolCallBlock,
  toolResultBlock,
  twoCallFlow,
} from './helpers.ts';

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

  it('renderToolResultText 仅含结果文本（无调用参数标记），走 pruner，无 result 为空串', () => {
    const session = makeSession({ events: twoCallFlow() });
    const cms = indexCompleteMessages(session);
    const tc = cms[2];
    if (!tc) throw new Error('缺少完整消息 2');
    const text = renderToolResultText(session, tc);
    expect(text).toContain('out1');
    expect(text).not.toContain('[tool-call');
    expect(text).not.toContain('firstCode()');
    expect(
      renderToolResultText(session, tc, { pruneContent: () => [{ type: 'text', text: '裁剪' }] }),
    ).toBe('裁剪');
    // 未配对 result 的 toolcall（防御条目）文本为空
    const ghostCm = indexCompleteMessages(
      makeSession({
        events: [
          {
            type: 'tool/result',
            data: {
              turn: 1,
              step: 1,
              message: makeMessage({
                role: 'user',
                content: [toolResultBlock('ghost', [textBlock('r')])],
                source: { kind: 'tool', callId: 'ghost' },
              }),
            },
          } as unknown as SessionEvent,
        ],
      }),
    )[0];
    expect(ghostCm && renderToolResultText(session, ghostCm)).toBe('');
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
