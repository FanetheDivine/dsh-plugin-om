// 压缩视图单测：观察视图（完整消息 → 条目）、反思视图（<history> 块 → 条目）、
// 条目 XML 渲染（转义 / 注释 / 属性）与工具名 / skill 名提取。
import { describe, expect, it } from 'vitest';
import {
  buildObserveView,
  buildReflectView,
  renderEntriesXml,
  skillNameOf,
  toolCallNameOf,
  type ViewEntry,
} from '../src/compress-view.ts';
import { indexCompleteMessages } from '../src/log-index.ts';
import type { SessionEvent } from '../src/types.ts';
import {
  imageBlock,
  makeMessage,
  makeSession,
  textBlock,
  toolCallBlock,
  toolResultBlock,
} from './helpers.ts';

/** 构造一条 assistant 消息事件。 */
function assistantEvent(content: unknown[], id = `assistant-${Math.random()}`) {
  return {
    type: 'assistant/message',
    data: {
      message: makeMessage({
        role: 'assistant',
        content,
        source: { kind: 'model', provider: 'test', model: 'test-model' },
        id,
      }),
    },
  } as SessionEvent;
}

/** 构造一条 user/message 事件。 */
function userEvent(content: unknown[], source?: unknown) {
  return {
    type: 'user/message',
    data: makeMessage({ content, ...(source ? { source } : {}) }),
  } as SessionEvent;
}

/** 构造一条 tool/result 事件（callId 关联）。 */
function resultEvent(callId: string, resultText: string) {
  return {
    type: 'tool/result',
    data: {
      turn: 1,
      step: 1,
      message: makeMessage({
        role: 'user',
        content: [toolResultBlock(callId, [textBlock(resultText)], false)],
        source: { kind: 'tool', callId },
      }),
    },
  } as SessionEvent;
}

describe('buildObserveView', () => {
  it('完整消息投影为条目：user 原文 / sys 空条目 / assistant 原文 / toolcall 带工具名 / reasoning 参考', () => {
    const session = makeSession({
      events: [
        userEvent([textBlock('用户请求')]),
        userEvent([textBlock('系统通知')], { kind: 'system' }),
        assistantEvent([{ type: 'reasoning', text: '先思考' }, textBlock('模型回复')]),
        assistantEvent([toolCallBlock('c1', 'run_code', '{"code":"x"}')]),
        resultEvent('c1', '执行结果'),
      ],
    });
    const view = buildObserveView(session, [0, 1, 2, 3, 4]);
    expect(view.minIndex).toBe(0);
    expect(view.maxIndex).toBe(3);
    expect(view.entries.map((e) => e.kind)).toEqual([
      'user',
      'sys',
      'reasoning',
      'assistant',
      'assistant',
    ]);
    const [user, sys, reasoning, text, toolcall] = view.entries;
    expect(user).toMatchObject({ lo: 0, hi: 0, text: '用户请求' });
    expect(sys).toMatchObject({ lo: 1, hi: 1, text: '', sysKind: 'system' });
    expect(reasoning).toMatchObject({ lo: 2, hi: 2, text: '先思考' });
    expect(text).toMatchObject({ lo: 2, hi: 2, text: '模型回复' });
    expect(toolcall).toMatchObject({ lo: 3, hi: 3, toolName: 'run_code' });
    expect(toolcall?.text).toContain('[tool-call run_code id=c1]');
    expect(toolcall?.text).toContain('执行结果');
  });

  it('图片等非文本块降级为注释，无内容用户消息不占条目', () => {
    const session = makeSession({
      events: [
        userEvent([textBlock('看图'), imageBlock({ name: 'a.png' })]),
        userEvent([]),
        assistantEvent([textBlock('回复')]),
      ],
    });
    const view = buildObserveView(session, [0, 1, 2]);
    // 空内容用户消息（index 1）不占条目，但 index 仍保留在区间内
    expect(view.entries).toHaveLength(2);
    expect(view.entries[0]).toMatchObject({ kind: 'user', lo: 0, text: '看图' });
    expect(view.entries[0]?.notes?.[0]).toContain('图片附件：a.png');
    expect(view.entries[1]).toMatchObject({ kind: 'assistant', lo: 2 });
    expect(view.minIndex).toBe(0);
    expect(view.maxIndex).toBe(2);
  });

  it('仅 seqs 全部落在集合内的完整消息进入视图', () => {
    const session = makeSession({
      events: [
        userEvent([textBlock('A')]),
        userEvent([textBlock('B')]),
        assistantEvent([textBlock('C')]),
      ],
    });
    const view = buildObserveView(session, [2]);
    expect(view.entries.map((e) => e.text)).toEqual(['C']);
  });

  it('skipReasoning=true：观察视图不含 reasoning 参考条目，其余条目不变', () => {
    const session = makeSession({
      events: [
        userEvent([textBlock('用户请求')]),
        assistantEvent([{ type: 'reasoning', text: '先思考' }, textBlock('模型回复')]),
      ],
    });
    const view = buildObserveView(session, [0, 1], { skipReasoning: true });
    expect(view.entries.map((e) => e.kind)).toEqual(['user', 'assistant']);
    expect(view.minIndex).toBe(0);
    expect(view.maxIndex).toBe(1);
  });

  it('toolCallNameOf 按 callId 定位工具名', () => {
    const session = makeSession({
      events: [assistantEvent([toolCallBlock('c9', 'skill', '{}')]), resultEvent('c9', 'ok')],
    });
    const cms = indexCompleteMessages(session);
    const first = cms[0];
    expect(first && toolCallNameOf(session, first)).toBe('skill');
  });

  it('skill 加载条目：正文仅含工具返回内容，带 toolName 与 skillName', () => {
    const session = makeSession({
      events: [
        assistantEvent([toolCallBlock('c1', 'skill', '{"name":"lark-im"}')]),
        resultEvent('c1', 'skill 加载内容'),
      ],
    });
    const view = buildObserveView(session, [0, 1]);
    expect(view.entries).toHaveLength(1);
    const skill = view.entries[0];
    expect(skill).toMatchObject({
      kind: 'assistant',
      lo: 0,
      hi: 0,
      toolName: 'skill',
      skillName: 'lark-im',
    });
    expect(skill?.text).toBe('skill 加载内容');
    expect(skill?.text).not.toContain('[tool-call');
  });

  it('skillNameOf：非 skill 工具为 undefined，skill 参数缺失或非法为空串', () => {
    const session = makeSession({
      events: [
        assistantEvent([toolCallBlock('c1', 'run_code', '{"code":"x"}')]),
        resultEvent('c1', 'ok'),
        assistantEvent([toolCallBlock('c2', 'skill', '{}')]),
        resultEvent('c2', 'ok'),
        assistantEvent([toolCallBlock('c3', 'skill', 'not-json')]),
        resultEvent('c3', 'ok'),
      ],
    });
    const cms = indexCompleteMessages(session);
    const [plain, missingName, invalidJson] = cms;
    if (!plain || !missingName || !invalidJson) throw new Error('完整消息数量不足');
    expect(skillNameOf(session, plain)).toBeUndefined();
    expect(skillNameOf(session, missingName)).toBe('');
    expect(skillNameOf(session, invalidJson)).toBe('');
  });
});

describe('buildReflectView', () => {
  it('块内条目投影：user / sys / assistant 单条与区间', () => {
    const block = `<history tip="x">\n<user_message index="0">用户原文</user_message>\n<sys type="system" index="1"></sys>\n<assistant index="2">单条摘要</assistant>\n<assistant start="3" end="5">区间摘要</assistant>\n</history>`;
    const view = buildReflectView([{ text: block, seq: 7 }]);
    expect(view.minIndex).toBe(0);
    expect(view.maxIndex).toBe(5);
    expect(view.entries).toHaveLength(4);
    expect(view.entries[0]).toMatchObject({
      kind: 'user',
      lo: 0,
      hi: 0,
      text: '用户原文',
      blockSeq: 7,
    });
    expect(view.entries[1]).toMatchObject({ kind: 'sys', lo: 1, hi: 1, sysKind: 'system' });
    expect(view.entries[2]).toMatchObject({ kind: 'assistant', lo: 2, hi: 2, text: '单条摘要' });
    expect(view.entries[3]).toMatchObject({ kind: 'assistant', lo: 3, hi: 5, text: '区间摘要' });
  });

  it('多块按序拼接，块间空隙不产生条目', () => {
    const b1 = '<history>\n<assistant index="0">A</assistant>\n</history>';
    const b2 = '<history>\n<assistant index="4">B</assistant>\n</history>';
    const view = buildReflectView([
      { text: b1, seq: 1 },
      { text: b2, seq: 5 },
    ]);
    expect(view.entries.map((e) => e.text)).toEqual(['A', 'B']);
    expect(view.minIndex).toBe(0);
    expect(view.maxIndex).toBe(4);
  });

  it('无法解析的块降级为不可定位的历史遗留条目（无区间）', () => {
    const view = buildReflectView([{ text: '<history><broken', seq: 3 }]);
    expect(view.entries).toHaveLength(1);
    expect(view.entries[0]).toMatchObject({ kind: 'assistant', blockSeq: 3 });
    expect(view.entries[0]?.lo).toBeUndefined();
    expect(view.minIndex).toBeUndefined();
    expect(view.maxIndex).toBeUndefined();
  });

  it('skipReasoning=true：反思视图不含 reasoning 参考条目', () => {
    const block =
      '<history>\n<reasoning>旧思考</reasoning>\n<assistant index="0">摘要</assistant>\n</history>';
    const kept = buildReflectView([{ text: block, seq: 7 }]);
    expect(kept.entries.map((e) => e.kind)).toEqual(['reasoning', 'assistant']);
    const skipped = buildReflectView([{ text: block, seq: 7 }], { skipReasoning: true });
    expect(skipped.entries.map((e) => e.kind)).toEqual(['assistant']);
    expect(skipped.entries[0]).toMatchObject({ kind: 'assistant', lo: 0, hi: 0 });
  });

  it('skill 条目解析为带 toolName 的 assistant 条目，重新渲染 round-trip 还原', () => {
    const block =
      '<history>\n<skill name="lark-im" index="5">skill 返回内容</skill>\n<assistant index="6">摘要</assistant>\n</history>';
    const view = buildReflectView([{ text: block, seq: 7 }]);
    expect(view.entries).toHaveLength(2);
    const skill = view.entries[0];
    expect(skill).toMatchObject({
      kind: 'assistant',
      lo: 5,
      hi: 5,
      text: 'skill 返回内容',
      toolName: 'skill',
      skillName: 'lark-im',
      blockSeq: 7,
    });
    // 反思轮定位与压缩挑战依赖 lo/hi；缺失 index 的 skill 条目不可定位、被跳过
    const noIndex = buildReflectView([
      { text: '<history>\n<skill name="x">内容</skill>\n</history>', seq: 8 },
    ]);
    expect(noIndex.entries).toHaveLength(1);
    expect(noIndex.entries[0]?.lo).toBeUndefined();
    // round-trip：解析后的条目重新渲染还原 <skill> 元素
    const xml = renderEntriesXml(view.entries);
    expect(xml).toContain('<skill name="lark-im" index="5">skill 返回内容</skill>');
    expect(xml).toContain('<assistant index="6">摘要</assistant>');
  });
});

describe('renderEntriesXml', () => {
  it('条目文本自动转义，user 注释输出为 XML 注释，无 history 包裹', () => {
    const xml = renderEntriesXml([
      { kind: 'user', lo: 0, hi: 0, text: 'a<b>&"c', notes: [' 图片附件 '] },
      { kind: 'sys', lo: 1, hi: 1, text: '', sysKind: 'system' },
      { kind: 'assistant', lo: 2, hi: 2, text: '摘要' },
      { kind: 'assistant', lo: 3, hi: 5, text: '区间摘要' },
    ]);
    expect(xml).not.toContain('<history');
    expect(xml).toContain(
      '<user_message index="0">a&lt;b&gt;&amp;"c<!-- 图片附件 --></user_message>',
    );
    expect(xml).toContain('<sys type="system" index="1"></sys>');
    expect(xml).toContain('<assistant index="2">摘要</assistant>');
    expect(xml).toContain('<assistant start="3" end="5">区间摘要</assistant>');
  });

  it('skill 条目输出 <skill name index> 元素，文本转义，name 缺省为空串', () => {
    const xml = renderEntriesXml([
      {
        kind: 'assistant',
        lo: 7,
        hi: 7,
        text: 'a<b 内容',
        toolName: 'skill',
        skillName: 'lark-doc',
      },
      { kind: 'assistant', lo: 8, hi: 8, text: '无名 skill', toolName: 'skill' },
    ]);
    expect(xml).toContain('<skill name="lark-doc" index="7">a&lt;b 内容</skill>');
    expect(xml).toContain('<skill name="" index="8">无名 skill</skill>');
  });

  it('空条目序列返回空串', () => {
    expect(renderEntriesXml([])).toBe('');
  });

  it('不可定位条目输出无属性 assistant 元素', () => {
    const xml = renderEntriesXml([{ kind: 'assistant', text: '遗留' } as ViewEntry]);
    expect(xml).toBe('<assistant>遗留</assistant>');
  });
});
