// 压缩视图单测：观察视图（完整消息 → 条目）、反思视图（<history> 块 → 条目）、
// 条目 XML 渲染（CDATA 包裹 / ]]> 拆段 / 注释 / 属性）与工具名 / skill 名提取。
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
    expect(toolcall).toMatchObject({
      lo: 3,
      hi: 3,
      toolName: 'run_code',
      callId: 'c1',
      toolArgs: '{"code":"x"}',
      toolResult: '执行结果',
    });
    // toolcall 条目渲染为结构化形态（与 recall 一致），不再输出 [tool-call] 纯文本
    const xml = renderEntriesXml(view.entries);
    expect(xml).toContain(
      '<assistant index="3" type="toolcall" tool-name="run_code" callId="c1"><tool-args><![CDATA[{"code":"x"}]]></tool-args><tool-result><![CDATA[执行结果]]></tool-result></assistant>',
    );
    expect(xml).not.toContain('[tool-call');
  });

  it('toolcall 调用参数仅一层转义：参数 JSON 内的换行与引号逐字保留', () => {
    const session = makeSession({
      events: [
        assistantEvent([toolCallBlock('c1', 'run_code', '{"code":"a()\nb(\')"}')]),
        resultEvent('c1', 'ok'),
      ],
    });
    const view = buildObserveView(session, [0, 1]);
    const xml = renderEntriesXml(view.entries);
    expect(xml).toContain('<tool-args><![CDATA[{"code":"a()\nb(\')"}]]></tool-args>');
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
  it('块内条目投影：user / sys / assistant 单条与区间（CDATA 正文经 textContent 还原）', () => {
    const block =
      '<history tip="x">\n<user_message index="0"><![CDATA[用户原文]]></user_message>\n<sys type="system" index="1"/>\n<assistant index="2"><![CDATA[单条摘要]]></assistant>\n<assistant start="3" end="5"><![CDATA[区间摘要]]></assistant>\n</history>';
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

  it('skill_content 条目解析为带 toolName 的 assistant 条目，重新渲染 round-trip 还原两段 CDATA', () => {
    const block =
      '<history>\n<skill_content name="lark-im" index="5"><skill_resources><![CDATA[资源内容]]></skill_resources><skill_instructions><![CDATA[指令内容]]></skill_instructions></skill_content>\n<assistant index="6"><![CDATA[摘要]]></assistant>\n</history>';
    const view = buildReflectView([{ text: block, seq: 7 }]);
    expect(view.entries).toHaveLength(2);
    const skill = view.entries[0];
    expect(skill).toMatchObject({
      kind: 'assistant',
      lo: 5,
      hi: 5,
      toolName: 'skill',
      skillName: 'lark-im',
      blockSeq: 7,
    });
    // 条目正文还原为原生 skill_content 包裹形态（供渲染时按两段拆分）
    expect(skill?.text).toBe(
      '<skill_content name="lark-im"><skill_resources>资源内容</skill_resources><skill_instructions>指令内容</skill_instructions></skill_content>',
    );
    // 反思轮定位与压缩挑战依赖 lo/hi；缺失 index 的 skill_content 条目不可定位、被跳过
    const noIndex = buildReflectView([
      { text: '<history>\n<skill_content name="x">内容</skill_content>\n</history>', seq: 8 },
    ]);
    expect(noIndex.entries).toHaveLength(1);
    expect(noIndex.entries[0]?.lo).toBeUndefined();
    // round-trip：解析后的条目重新渲染还原 skill_content 两段 CDATA 结构
    const xml = renderEntriesXml(view.entries);
    expect(xml).toContain(
      '<skill_content name="lark-im" index="5"><skill_resources><![CDATA[资源内容]]></skill_resources><skill_instructions><![CDATA[指令内容]]></skill_instructions></skill_content>',
    );
    expect(xml).toContain('<assistant index="6"><![CDATA[摘要]]></assistant>');
  });

  it('结构化 toolcall 条目解析出参数与返回，round-trip 逐字还原结构', () => {
    const block =
      '<history>\n<assistant index="3" type="toolcall" tool-name="run_code" callId="c1"><tool-args><![CDATA[{"code":"x"}]]></tool-args><tool-result><![CDATA[执行结果]]></tool-result></assistant>\n</history>';
    const view = buildReflectView([{ text: block, seq: 7 }]);
    expect(view.entries[0]).toMatchObject({
      kind: 'assistant',
      lo: 3,
      hi: 3,
      toolName: 'run_code',
      callId: 'c1',
      toolArgs: '{"code":"x"}',
      toolResult: '执行结果',
      blockSeq: 7,
    });
    expect(renderEntriesXml(view.entries)).toBe(
      '<assistant index="3" type="toolcall" tool-name="run_code" callId="c1"><tool-args><![CDATA[{"code":"x"}]]></tool-args><tool-result><![CDATA[执行结果]]></tool-result></assistant>',
    );
  });

  it('旧格式块的 toolcall 纯文本条目仍按纯文本解析与渲染（向后兼容）', () => {
    const block =
      '<history>\n<assistant index="2"><![CDATA[[tool-call run_code id=c1]\n{"code":"x"}]]></assistant>\n</history>';
    const view = buildReflectView([{ text: block, seq: 1 }]);
    expect(view.entries[0]).toMatchObject({ kind: 'assistant', lo: 2, hi: 2 });
    expect(view.entries[0]?.toolArgs).toBeUndefined();
    expect(renderEntriesXml(view.entries)).toBe(
      '<assistant index="2"><![CDATA[[tool-call run_code id=c1]\n{"code":"x"}]]></assistant>',
    );
  });

  it('非原生结构的 skill_content 条目回退为整体 CDATA 原文，round-trip 逐字还原', () => {
    const block =
      '<history>\n<skill_content name="x" index="1"><![CDATA[纯返回内容]]></skill_content>\n</history>';
    const view = buildReflectView([{ text: block, seq: 7 }]);
    expect(view.entries[0]).toMatchObject({
      kind: 'assistant',
      lo: 1,
      hi: 1,
      toolName: 'skill',
      skillName: 'x',
      text: '纯返回内容',
    });
    expect(renderEntriesXml(view.entries)).toBe(
      '<skill_content name="x" index="1"><![CDATA[纯返回内容]]></skill_content>',
    );
  });
});

describe('ask_user_question 条目', () => {
  it('观察视图：ask_user_question 工具调用渲染为 <askuserquestion> 专用元素，内含 questions/answers 两段 CDATA', () => {
    const session = makeSession({
      events: [
        assistantEvent([
          toolCallBlock(
            'c1',
            'ask_user_question',
            '{"questions":[{"id":"q1","question":"继续吗"}]}',
          ),
        ]),
        resultEvent('c1', '继续'),
      ],
    });
    const view = buildObserveView(session, [0, 1]);
    expect(view.entries).toHaveLength(1);
    const ask = view.entries[0];
    expect(ask).toMatchObject({
      kind: 'assistant',
      lo: 0,
      hi: 0,
      toolName: 'ask_user_question',
    });
    // 条目正文还原为原生 askuserquestion 包裹形态（供渲染时按两段拆分）
    expect(ask?.text).toBe(
      '<askuserquestion><questions>{"questions":[{"id":"q1","question":"继续吗"}]}</questions><answers>继续</answers></askuserquestion>',
    );
    const xml = renderEntriesXml(view.entries);
    expect(xml).toBe(
      '<askuserquestion index="0"><questions><![CDATA[{"questions":[{"id":"q1","question":"继续吗"}]}]]></questions><answers><![CDATA[继续]]></answers></askuserquestion>',
    );
  });

  it('观察视图：ask_user_question 无返回内容时仅输出 questions 段', () => {
    const session = makeSession({
      events: [
        assistantEvent([toolCallBlock('c1', 'ask_user_question', '{"questions":["q"]}')]),
        resultEvent('c1', ''),
      ],
    });
    const view = buildObserveView(session, [0, 1]);
    const xml = renderEntriesXml(view.entries);
    expect(xml).toBe(
      '<askuserquestion index="0"><questions><![CDATA[{"questions":["q"]}]]></questions></askuserquestion>',
    );
  });

  it('反思视图：askuserquestion 条目解析为带 toolName 的 assistant 条目，round-trip 还原两段 CDATA', () => {
    const block =
      '<history>\n<askuserquestion index="5"><questions><![CDATA[{"questions":["继续吗"]}]]></questions><answers><![CDATA[继续]]></answers></askuserquestion>\n<assistant index="6"><![CDATA[摘要]]></assistant>\n</history>';
    const view = buildReflectView([{ text: block, seq: 7 }]);
    expect(view.entries).toHaveLength(2);
    const ask = view.entries[0];
    expect(ask).toMatchObject({
      kind: 'assistant',
      lo: 5,
      hi: 5,
      toolName: 'ask_user_question',
      blockSeq: 7,
    });
    expect(ask?.text).toBe(
      '<askuserquestion><questions>{"questions":["继续吗"]}</questions><answers>继续</answers></askuserquestion>',
    );
    // 缺失 index 的 askuserquestion 条目不可定位、被跳过
    const noIndex = buildReflectView([
      {
        text: '<history>\n<askuserquestion><answers>x</answers></askuserquestion>\n</history>',
        seq: 8,
      },
    ]);
    expect(noIndex.entries).toHaveLength(1);
    expect(noIndex.entries[0]?.lo).toBeUndefined();
    // round-trip：解析后的条目重新渲染还原两段 CDATA 结构
    const xml = renderEntriesXml(view.entries);
    expect(xml).toContain(
      '<askuserquestion index="5"><questions><![CDATA[{"questions":["继续吗"]}]]></questions><answers><![CDATA[继续]]></answers></askuserquestion>',
    );
  });

  it('反思视图：非原生结构的 askuserquestion 条目回退为整体 CDATA 原文，round-trip 逐字还原', () => {
    const block =
      '<history>\n<askuserquestion index="1"><![CDATA[纯文本内容]]></askuserquestion>\n</history>';
    const view = buildReflectView([{ text: block, seq: 7 }]);
    expect(view.entries[0]).toMatchObject({
      kind: 'assistant',
      lo: 1,
      hi: 1,
      toolName: 'ask_user_question',
      text: '纯文本内容',
    });
    expect(renderEntriesXml(view.entries)).toBe(
      '<askuserquestion index="1"><![CDATA[纯文本内容]]></askuserquestion>',
    );
  });
});

describe('renderEntriesXml', () => {
  it('条目正文以 CDATA 包裹，user 注释输出为 XML 注释，无 history 包裹', () => {
    const xml = renderEntriesXml([
      { kind: 'user', lo: 0, hi: 0, text: 'a<b>&"c', notes: [' 图片附件 '] },
      { kind: 'sys', lo: 1, hi: 1, text: '', sysKind: 'system' },
      { kind: 'assistant', lo: 2, hi: 2, text: '摘要' },
      { kind: 'assistant', lo: 3, hi: 5, text: '区间摘要' },
    ]);
    expect(xml).not.toContain('<history');
    expect(xml).toContain(
      '<user_message index="0"><![CDATA[a<b>&"c]]><!-- 图片附件 --></user_message>',
    );
    expect(xml).toContain('<sys type="system" index="1"/>');
    expect(xml).toContain('<assistant index="2"><![CDATA[摘要]]></assistant>');
    expect(xml).toContain('<assistant start="3" end="5"><![CDATA[区间摘要]]></assistant>');
  });

  it('skill_content 条目输出两段 CDATA 结构，非原生结构回退整体 CDATA，name 缺省为空串', () => {
    const xml = renderEntriesXml([
      {
        kind: 'assistant',
        lo: 7,
        hi: 7,
        text: '<skill_content name="lark-doc"><skill_resources>资源</skill_resources><skill_instructions>指令</skill_instructions></skill_content>',
        toolName: 'skill',
        skillName: 'lark-doc',
      },
      { kind: 'assistant', lo: 8, hi: 8, text: 'a<b 内容', toolName: 'skill', skillName: '' },
    ]);
    expect(xml).toContain(
      '<skill_content name="lark-doc" index="7"><skill_resources><![CDATA[资源]]></skill_resources><skill_instructions><![CDATA[指令]]></skill_instructions></skill_content>',
    );
    expect(xml).toContain('<skill_content name="" index="8"><![CDATA[a<b 内容]]></skill_content>');
  });

  it('正文含 ]]> 时拆为相邻 CDATA 段，解析还原逐字原文', () => {
    const xml = renderEntriesXml([{ kind: 'assistant', lo: 0, hi: 0, text: 'a]]>b' }]);
    expect(xml).toBe('<assistant index="0"><![CDATA[a]]><![CDATA[]]]]><![CDATA[>b]]></assistant>');
    const view = buildReflectView([{ text: `<history>\n${xml}\n</history>`, seq: 1 }]);
    expect(view.entries[0]).toMatchObject({ kind: 'assistant', lo: 0, hi: 0, text: 'a]]>b' });
  });

  it('空条目序列返回空串', () => {
    expect(renderEntriesXml([])).toBe('');
  });

  it('不可定位条目输出无属性 assistant 元素（CDATA 正文）', () => {
    const xml = renderEntriesXml([{ kind: 'assistant', text: '遗留' } as ViewEntry]);
    expect(xml).toBe('<assistant><![CDATA[遗留]]></assistant>');
  });
});
