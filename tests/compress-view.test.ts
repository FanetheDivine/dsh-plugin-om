// 压缩视图单测：观察视图（完整消息 → 条目）、反思视图（<history> 块 → 条目）、
// 条目 XML 渲染（CDATA 包裹 / ]]> 拆段 / 注释 / 属性）与工具名 / skill 名提取。
import { describe, expect, it } from 'vitest';
import { CompressionState } from '../src/compress-tools.ts';
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
import { imageBlock, makeMessage, makeSession, textBlock, toolCallBlock } from './helpers.ts';

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
  } as unknown as SessionEvent;
}

/** 构造一条 user/message 事件。 */
function userEvent(content: unknown[], source?: unknown) {
  return {
    type: 'user/message',
    data: makeMessage({ content, ...(source ? { source } : {}) }),
  } as unknown as SessionEvent;
}

/** 构造一条 tool/result 事件（callId 关联；message 为独立 tool 角色）。 */
function resultEvent(callId: string, resultText: string, isError = false) {
  return {
    type: 'tool/result',
    data: {
      turn: 1,
      step: 1,
      message: {
        ...makeMessage({
          role: 'tool',
          content: [textBlock(resultText)],
          source: { kind: 'tool', callId },
        }),
        toolCallId: callId,
        isError,
      },
    },
  } as unknown as SessionEvent;
}

describe('buildObserveView', () => {
  it('完整消息投影为条目：user 原文 / 系统消息不入视图 / assistant 原文 / toolcall 带工具名 / reasoning 参考', () => {
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
    expect(view.maxIndex).toBe(2);
    expect(view.entries.map((e) => e.kind)).toEqual([
      'user',
      'reasoning',
      'assistant',
      'assistant',
    ]);
    const [user, reasoning, text, toolcall] = view.entries;
    expect(user).toMatchObject({ lo: 0, hi: 0, text: '用户请求' });
    expect(reasoning).toMatchObject({ lo: 1, hi: 1, text: '先思考' });
    expect(text).toMatchObject({ lo: 1, hi: 1, text: '模型回复' });
    expect(toolcall).toMatchObject({
      lo: 2,
      hi: 2,
      toolName: 'run_code',
      callId: 'c1',
      toolArgs: '{"code":"x"}',
      toolResult: '执行结果',
    });
    // toolcall 条目渲染为结构化形态（与 recall 一致），不再输出 [tool-call] 纯文本
    const xml = renderEntriesXml(view.entries);
    expect(xml).toContain(
      '<assistant index="2" type="toolcall" tool-name="run_code" callId="c1"><tool-args><![CDATA[{"code":"x"}]]></tool-args><tool-result><![CDATA[执行结果]]></tool-result></assistant>',
    );
    expect(xml).not.toContain('[tool-call');
    expect(xml).not.toContain('系统通知');
    expect(xml).not.toContain('<sys');
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

  it('系统消息（含手动加载的 skill）不占 index；工具加载的 skill 保持不可直接压缩', () => {
    const session = makeSession({
      events: [
        userEvent([textBlock('用户输入')]),
        userEvent([textBlock('技能目录')], { kind: 'skill-catalog', form: 'catalog' }),
        userEvent(
          [
            textBlock(
              '<skill_content name="manual"><skill_resources>路径</skill_resources><skill_instructions>执行</skill_instructions></skill_content>',
            ),
          ],
          {
            kind: 'skill-invocation',
            name: 'manual',
            form: 'instructions',
          },
        ),
        assistantEvent([toolCallBlock('c1', 'skill', '{"name":"tool-loaded"}')]),
        resultEvent(
          'c1',
          '<skill_content name="tool-loaded"><skill_resources>位置</skill_resources><skill_instructions>步骤</skill_instructions></skill_content>',
        ),
        userEvent([textBlock('系统通知')], { kind: 'runtime-context' }),
      ],
    });
    const view = buildObserveView(session, [0, 1, 2, 3, 4, 5]);
    expect(
      view.entries.map(({ kind, lo, toolName, skillName }) => ({ kind, lo, toolName, skillName })),
    ).toEqual([
      { kind: 'user', lo: 0, toolName: undefined, skillName: undefined },
      { kind: 'assistant', lo: 1, toolName: 'skill', skillName: 'tool-loaded' },
    ]);
    const xml = renderEntriesXml(view.entries);
    expect(xml).toContain('<skill_content name="tool-loaded" index="1">');
    expect(xml).not.toContain('manual');
    expect(xml).not.toContain('<sys');
    const state = new CompressionState(view);
    expect(state.compressHistory({ index: 1, content: '摘要' }).isError).toBe(true);
    expect(state.compressHistory({ index: 1, content: '摘要' }).isError).toBe(false);
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
  it('块内条目投影：user / assistant 单条与区间，旧 sys 与未知标签被忽略（CDATA 正文经 textContent 还原）', () => {
    const block =
      '<history tip="x">\n<user_message index="0"><![CDATA[用户原文]]></user_message>\n<sys type="system" index="1"/>\n<unknown index="9"><![CDATA[未知]]></unknown>\n<assistant index="2"><![CDATA[单条摘要]]></assistant>\n<assistant start="3" end="5"><![CDATA[区间摘要]]></assistant>\n</history>';
    const view = buildReflectView([{ text: block, seq: 7 }]);
    expect(view.minIndex).toBe(0);
    expect(view.maxIndex).toBe(5);
    expect(view.entries).toHaveLength(3);
    expect(view.entries[0]).toMatchObject({
      kind: 'user',
      lo: 0,
      hi: 0,
      text: '用户原文',
      blockSeq: 7,
    });
    expect(view.entries[1]).toMatchObject({ kind: 'assistant', lo: 2, hi: 2, text: '单条摘要' });
    expect(view.entries[2]).toMatchObject({ kind: 'assistant', lo: 3, hi: 5, text: '区间摘要' });
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
  it('观察视图：按问题 id 与回答配对，逐题输出 q:/a: 成对行', () => {
    const session = makeSession({
      events: [
        assistantEvent([
          toolCallBlock(
            'c1',
            'ask_user_question',
            '{"questions":[{"id":"q1","question":"继续吗"},{"id":"q2","question":"如何处理"}]}',
          ),
        ]),
        // 回答顺序与问题顺序相反，配对以 id 为准而非数组下标
        resultEvent(
          'c1',
          '{"answers":[{"id":"q2","selected":["重试"]},{"id":"q1","selected":["继续"]}]}',
        ),
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
      ask: {
        questions: [
          { question: '继续吗', options: [], answer: '继续' },
          { question: '如何处理', options: [], answer: '重试' },
        ],
      },
    });
    // 条目正文为原生 ask-user-question 包裹形态，内文为成对的 q:/a: 行
    expect(ask?.text).toBe(
      '<ask-user-question>q:继续吗\na:继续\nq:如何处理\na:重试</ask-user-question>',
    );
    const xml = renderEntriesXml(view.entries);
    expect(xml).toBe(
      '<ask-user-question index="0"><![CDATA[q:继续吗\na:继续\nq:如何处理\na:重试]]></ask-user-question>',
    );
  });

  it('观察视图：多选题的多个所选拼接为一段回答，自定义回答追加在所选之后', () => {
    const session = makeSession({
      events: [
        assistantEvent([
          toolCallBlock(
            'c1',
            'ask_user_question',
            '{"questions":[{"id":"scope","question":"适用范围？","multiSelect":true}]}',
          ),
        ]),
        resultEvent(
          'c1',
          '{"answers":[{"id":"scope","selected":["列表","详情"],"custom":"其他页面"}]}',
        ),
      ],
    });
    const xml = renderEntriesXml(buildObserveView(session, [0, 1]).entries);
    expect(xml).toBe(
      '<ask-user-question index="0"><![CDATA[q:适用范围？\na:列表, 详情, 其他页面]]></ask-user-question>',
    );
  });

  it('观察视图：各题空答案仍为合法问答，自定义答案无需选择选项', () => {
    const session = makeSession({
      events: [
        assistantEvent([
          toolCallBlock(
            'c1',
            'ask_user_question',
            '{"questions":[{"id":"q1","question":"继续吗"},{"id":"q2","question":"如何处理"}]}',
          ),
        ]),
        resultEvent(
          'c1',
          '{"answers":[{"id":"q1","selected":[],"custom":""},{"id":"q2","selected":[],"custom":"稍后处理"}]}',
        ),
      ],
    });
    const xml = renderEntriesXml(buildObserveView(session, [0, 1]).entries);
    expect(xml).toBe(
      '<ask-user-question index="0"><![CDATA[q:继续吗\na:(未回答)\nq:如何处理\na:稍后处理]]></ask-user-question>',
    );
  });

  const validArgs = '{"questions":[{"id":"q1","question":"继续吗"}]}';
  const validResult = '{"answers":[{"id":"q1","selected":["继续"]}]}';
  const invalidCalls = [
    {
      name: 'abort',
      result: 'Error: ask_user_question was aborted before the user answered',
      isError: true,
    },
    { name: '宿主错误且正文貌似合法', result: validResult, isError: true },
    { name: '无 result', result: undefined },
    { name: '空结果', result: '' },
    { name: '普通错误文本', result: '工具调用被拒绝' },
    { name: '坏结果 JSON', result: '{broken' },
    { name: 'pending', result: '{"pending":true,"answers":[{"id":"q1","selected":["继续"]}]}' },
    { name: '显式 error', result: '{"error":"失败","answers":[{"id":"q1","selected":["继续"]}]}' },
    {
      name: '显式 aborted',
      result: '{"aborted":true,"answers":[{"id":"q1","selected":["继续"]}]}',
    },
    { name: '缺 answers', result: '{}' },
    { name: '缺 answer 项', result: '{"answers":[]}' },
    { name: '未知 answer id', result: '{"answers":[{"id":"ghost","selected":["继续"]}]}' },
    {
      name: '重复 answer id',
      result: '{"answers":[{"id":"q1","selected":["继续"]},{"id":"q1","selected":[]}]}',
    },
    {
      name: '额外未知 answer',
      result: '{"answers":[{"id":"q1","selected":[]},{"id":"ghost","selected":["野回答"]}]}',
    },
    { name: 'answer 缺 id', result: '{"answers":[{"selected":[]}]}' },
    { name: 'answer 缺 selected', result: '{"answers":[{"id":"q1","custom":"回答"}]}' },
    { name: 'selected 非字符串数组', result: '{"answers":[{"id":"q1","selected":["继续",1]}]}' },
    { name: 'selected 非数组', result: '{"answers":[{"id":"q1","selected":"继续"}]}' },
    { name: 'custom 非字符串', result: '{"answers":[{"id":"q1","selected":[],"custom":null}]}' },
    { name: 'answer 非对象', result: '{"answers":[null]}' },
    { name: '坏参数 JSON', args: '{broken', result: validResult },
    { name: '缺 questions', args: '{"other":1}', result: validResult },
    { name: '空 questions', args: '{"questions":[]}', result: validResult },
    { name: '字符串问题', args: '{"questions":["继续吗"]}', result: validResult },
    { name: 'question 缺 id', args: '{"questions":[{"question":"继续吗"}]}', result: validResult },
    {
      name: '空白 id',
      args: '{"questions":[{"id":" ","question":"继续吗"}]}',
      result: validResult,
    },
    {
      name: '空白 question',
      args: '{"questions":[{"id":"q1","question":" "}]}',
      result: validResult,
    },
    {
      name: '重复 question id',
      args: '{"questions":[{"id":"q1","question":"继续吗"},{"id":"q1","question":"如何处理"}]}',
      result: validResult,
    },
    {
      name: '问题中夹杂非法项',
      args: '{"questions":[{"id":"q1","question":"继续吗"},null]}',
      result: validResult,
    },
    {
      name: '多题缺回答',
      args: '{"questions":[{"id":"q1","question":"继续吗"},{"id":"q2","question":"如何处理"}]}',
      result: validResult,
    },
  ];

  it.each(invalidCalls)(
    '观察视图：$name 整体保留为普通 structured toolcall',
    ({ args = validArgs, result, isError = false }) => {
      const events = [assistantEvent([toolCallBlock('c1', 'ask_user_question', args)])];
      if (result !== undefined) events.push(resultEvent('c1', result, isError));
      const view = buildObserveView(
        makeSession({ events }),
        events.map((_, index) => index),
      );
      expect(view.entries).toHaveLength(1);
      expect(view.entries[0]).toMatchObject({
        toolName: 'ask_user_question',
        callId: 'c1',
        toolArgs: args,
        ...(result === undefined ? {} : { toolResult: result }),
      });
      const xml = renderEntriesXml(view.entries);
      expect(xml).toContain(
        '<assistant index="0" type="toolcall" tool-name="ask_user_question" callId="c1">',
      );
      expect(xml).toContain(`<tool-args><![CDATA[${args}]]></tool-args>`);
      if (result !== undefined && result !== '')
        expect(xml).toContain(`<tool-result><![CDATA[${result}]]></tool-result>`);
      expect(xml).not.toContain('<ask-user-question');
      expect(xml).not.toContain('<askuserquestion');
    },
  );

  it('观察视图：工具结果 source 配对但实际 toolCallId 不匹配，不能生成 ask', () => {
    const result = resultEvent('c1', validResult);
    if (result.type !== 'tool/result') throw new Error('Expected tool result');
    result.data.message = {
      ...result.data.message,
      toolCallId: 'other-call' as typeof result.data.message.toolCallId,
    };
    const view = buildObserveView(
      makeSession({
        events: [assistantEvent([toolCallBlock('c1', 'ask_user_question', validArgs)]), result],
      }),
      [0, 1],
    );
    expect(view.entries[0]).toMatchObject({
      toolName: 'ask_user_question',
      callId: 'c1',
      toolArgs: validArgs,
      toolResult: validResult,
    });
    expect(view.entries[0]?.ask).toBeUndefined();
    expect(renderEntriesXml(view.entries)).not.toContain('<ask-user-question');
  });

  it('观察视图：成功正文附有宿主失败身份仍是普通 toolcall', () => {
    const result = resultEvent('c1', validResult);
    if (result.type !== 'tool/result') throw new Error('Expected tool result');
    result.data.error = { name: 'UserQuestionError', code: 'ASK_ABORTED' };
    const view = buildObserveView(
      makeSession({
        events: [assistantEvent([toolCallBlock('c1', 'ask_user_question', validArgs)]), result],
      }),
      [0, 1],
    );
    expect(view.entries[0]).toMatchObject({ toolArgs: validArgs, toolResult: validResult });
    expect(view.entries[0]?.ask).toBeUndefined();
  });

  it('观察视图：真实提问数据按题成对呈现（问题顺序与回答顺序不同）', () => {
    const session = makeSession({
      events: [
        assistantEvent([
          toolCallBlock(
            'c1',
            'ask_user_question',
            '{"questions":[{"id":"hideScoreScope","question":"问题3「只展示等级不展示评分」的适用范围？"},{"id":"dupIcon","question":"问题2 确认：删除的是粉丝数行中重复的平台图标（保留头像右下角角标）？"}]}',
          ),
        ]),
        resultEvent(
          'c1',
          '{"answers":[{"id":"hideScoreScope","selected":["仅团队达人库列表"]},{"id":"dupIcon","selected":["是，删除粉丝数行的重复图标 (Recommended)"]}]}',
        ),
      ],
    });
    const xml = renderEntriesXml(buildObserveView(session, [0, 1]).entries);
    expect(xml).toBe(
      '<ask-user-question index="0"><![CDATA[q:问题3「只展示等级不展示评分」的适用范围？\na:仅团队达人库列表\nq:问题2 确认：删除的是粉丝数行中重复的平台图标（保留头像右下角角标）？\na:是，删除粉丝数行的重复图标 (Recommended)]]></ask-user-question>',
    );
  });

  it('观察视图：选项完整呈现，多行和 XML 特殊字符可经反思原样还原', () => {
    const questions = [
      {
        id: 'release',
        question: '发布方式？\n<保留>&]]>',
        options: [
          { label: '灰度\n发布', description: '少量用户\n<逐步>&]]>' },
          { label: '全量', description: '' },
          { label: '暂缓' },
        ],
      },
      { id: 'note', question: '备注？' },
    ];
    const answers = [
      { id: 'note', selected: [], custom: '自由回答\nq:不是新问题\na:也不是新答案' },
      { id: 'release', selected: ['第一个'], custom: '<补充>&]]>\n下一行' },
    ];
    const session = makeSession({
      events: [
        assistantEvent([toolCallBlock('c1', 'ask_user_question', JSON.stringify({ questions }))]),
        resultEvent('c1', JSON.stringify({ answers })),
      ],
    });
    const view = buildObserveView(session, [0, 1]);
    expect(view.entries[0]?.ask).toEqual({
      questions: [
        {
          question: questions[0]?.question,
          options: questions[0]?.options,
          answer: '第一个, <补充>&]]>\n下一行',
        },
        { question: '备注？', options: [], answer: '自由回答\nq:不是新问题\na:也不是新答案' },
      ],
    });
    const body =
      'q:发布方式？\n<保留>&]]>\no1:灰度\n发布 — 少量用户\n<逐步>&]]>\no2:全量\no3:暂缓\na:第一个, <补充>&]]>\n下一行\nq:备注？\na:自由回答\nq:不是新问题\na:也不是新答案';
    const xml = renderEntriesXml(view.entries);
    expect(xml).toContain('<ask-user-question index="0"><![CDATA[q:发布方式？');
    const reflect = buildReflectView([{ text: `<history>${xml}</history>`, seq: 2 }]);
    expect(reflect.entries[0]?.text).toBe(`<ask-user-question>${body}</ask-user-question>`);
    expect(reflect.entries[0]?.ask).toBeUndefined();
    expect(renderEntriesXml(reflect.entries)).toBe(xml);
  });

  it.each([
    { options: null },
    { options: 'bad' },
    { options: [null] },
    { options: [{ description: 'missing label' }] },
    { options: [{ label: 1 }] },
    { options: [{ label: '选择', description: null }] },
  ])('观察视图：非法 options $options 整调用回退且保留原参数', ({ options }) => {
    const args = JSON.stringify({ questions: [{ id: 'q1', question: '继续吗', options }] });
    const view = buildObserveView(
      makeSession({
        events: [
          assistantEvent([toolCallBlock('c1', 'ask_user_question', args)]),
          resultEvent('c1', validResult),
        ],
      }),
      [0, 1],
    );
    expect(view.entries[0]).toMatchObject({ toolArgs: args, toolResult: validResult });
    expect(view.entries[0]?.ask).toBeUndefined();
    expect(renderEntriesXml(view.entries)).not.toContain('<ask-user-question');
  });

  it('反思视图：旧格式 askuserquestion 条目解析为带 toolName 的 assistant 条目，round-trip 保持旧格式原样', () => {
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
    expect(ask?.ask).toBeUndefined();
    expect(ask?.text).toBe(
      '<askuserquestion><questions>{"questions":["继续吗"]}</questions><answers>继续</answers></askuserquestion>',
    );
    // 缺失 index 的旧格式条目不可定位、被跳过
    const noIndex = buildReflectView([
      {
        text: '<history>\n<askuserquestion><answers>x</answers></askuserquestion>\n</history>',
        seq: 8,
      },
    ]);
    expect(noIndex.entries).toHaveLength(1);
    expect(noIndex.entries[0]?.lo).toBeUndefined();
    // round-trip：解析后的旧格式条目重新渲染保持旧格式结构
    const xml = renderEntriesXml(view.entries);
    expect(xml).toContain(
      '<askuserquestion index="5"><questions><![CDATA[{"questions":["继续吗"]}]]></questions><answers><![CDATA[继续]]></answers></askuserquestion>',
    );
  });

  it('反思视图：ask-user-question 条目解析为带 toolName 的 assistant 条目，round-trip 还原 q:/a: CDATA', () => {
    const block =
      '<history>\n<ask-user-question index="5"><![CDATA[q:继续吗 a:继续]]></ask-user-question>\n<assistant index="6"><![CDATA[摘要]]></assistant>\n</history>';
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
    expect(ask?.ask).toBeUndefined();
    expect(ask?.text).toBe('<ask-user-question>q:继续吗 a:继续</ask-user-question>');
    // 缺失 index 的 ask-user-question 条目不可定位、被跳过
    const noIndex = buildReflectView([
      {
        text: '<history>\n<ask-user-question><![CDATA[q:问题 a:(未回答)]]></ask-user-question>\n</history>',
        seq: 8,
      },
    ]);
    expect(noIndex.entries).toHaveLength(1);
    expect(noIndex.entries[0]?.lo).toBeUndefined();
    // round-trip：解析后的条目重新渲染还原 q:/a: CDATA 结构
    const xml = renderEntriesXml(view.entries);
    expect(xml).toContain(
      '<ask-user-question index="5"><![CDATA[q:继续吗 a:继续]]></ask-user-question>',
    );
  });

  it('反思视图：非原生结构的 askuserquestion 条目回退为整体 CDATA 原文，round-trip 保持旧格式', () => {
    const block =
      '<history>\n<askuserquestion index="1"><![CDATA[纯文本内容]]></askuserquestion>\n</history>';
    const view = buildReflectView([{ text: block, seq: 7 }]);
    expect(view.entries[0]).toMatchObject({
      kind: 'assistant',
      lo: 1,
      hi: 1,
      toolName: 'ask_user_question',
      text: '<askuserquestion>纯文本内容</askuserquestion>',
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
      { kind: 'assistant', lo: 2, hi: 2, text: '摘要' },
      { kind: 'assistant', lo: 3, hi: 5, text: '区间摘要' },
    ]);
    expect(xml).not.toContain('<history');
    expect(xml).toContain(
      '<user_message index="0"><![CDATA[a<b>&"c]]><!-- 图片附件 --></user_message>',
    );
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
