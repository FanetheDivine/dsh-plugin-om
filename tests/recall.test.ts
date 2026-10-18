// recall.ts 单元测试：recall 工具行为（start/end/offset 区间、pruner 裁剪、subagent 拒绝、
// 图片附件）、wire 参数 schema 与参数校验 parseRecallArgs。
import { describe, expect, it } from 'vitest';
import { COMPLETE_MESSAGE_DEFINITION } from '../src/constants.ts';
import { buildRecallTool, parseRecallArgs } from '../src/recall.ts';
import type { RecallOutputValue } from '../src/recall-output.ts';
import type { SessionEvent } from '../src/types.ts';
import {
  buildToolCallFlow,
  imageBlock,
  makeMessage,
  makeSession,
  textBlock,
  textOf,
  toolCallBlock,
  twoCallFlow,
} from './helpers.ts';

describe('recall 工具', () => {
  it('描述说明 index 用法并携带完整消息定义', () => {
    const { description } = buildRecallTool();
    expect(description).toContain('index');
    expect(description).toContain(COMPLETE_MESSAGE_DEFINITION);
  });

  it('start+end 返回区间内全部完整消息（含代码与结果），输出标 index/类型', async () => {
    const session = makeSession({ events: twoCallFlow() });
    const tool = buildRecallTool();
    const exec = { agent: { session } };
    const span = textOf(await tool.execute({ start: 0, end: 5 }, exec as never));
    expect(span).toContain('firstCode()');
    expect(span).toContain('secondCode()');
    expect(span).toContain('out1');
    expect(span).toContain('out2');
    expect(String(span)).toContain('<user_message index="0">');
    expect(String(span)).toContain('<assistant index="2" type="toolcall" tool-name="run_code">');
    expect(String(span)).toContain('<assistant index="5" type="toolcall" tool-name="run_code">');
    expect(String(span)).not.toContain('callId');
  });

  it('手动加载的 skill 输出 skill_content 条目，其余系统消息不出现', async () => {
    const skillEvent = (text: string, source: object, id: string) =>
      ({
        type: 'user/message',
        data: makeMessage({ content: [textBlock(text)], source, id }),
      }) as unknown as SessionEvent;
    const session = makeSession({
      events: [
        skillEvent('技能目录正文', { kind: 'skill-catalog', form: 'catalog' }, 'cat'),
        skillEvent(
          '<skill_content name="lark-im">步骤</skill_content>',
          { kind: 'skill-invocation', name: 'lark-im', form: 'instructions' },
          'inv',
        ),
      ],
    });
    const tool = buildRecallTool();
    const text = String(
      textOf(await tool.execute({ start: 0, end: 0 }, { agent: { session } } as never)),
    );
    expect(text).toContain('<skill_content index="0" name="lark-im">');
    expect(text).toContain('步骤');
    expect(text).not.toContain('技能目录正文');
  });

  it('toolcall 条目输出 tool-args/tool-result CDATA（args 为合法 JSON 且仅一层转义）', async () => {
    const flow = buildToolCallFlow({
      code: 'a()\nb()',
      description: '多行',
      callId: 'cn',
      resultText: 'r\n多行结果',
    });
    const session = makeSession({ events: flow });
    const exec = { agent: { session } };
    const span = textOf(await buildRecallTool().execute({ start: 2, offset: 0 }, exec as never));
    const args = span.match(/<tool-args><!\[CDATA\[([\s\S]*?)\]\]><\/tool-args>/)?.[1];
    expect(args).toBeDefined();
    expect(JSON.parse(args as string)).toEqual({ code: 'a()\nb()', description: '多行' });
    // 仅一层 JSON 转义：真实换行序列化为 \n，而不是 safeJson 二次转义的 \\n
    expect(span).toContain('a()\\nb()');
    expect(span).not.toContain('\\\\n');
    const result = span.match(/<tool-result><!\[CDATA\[([\s\S]*?)\]\]><\/tool-result>/)?.[1];
    expect(result).toBe('r\n多行结果');
  });

  it('end 在 start 之前时仍输出两者间全部完整消息（顺序无关）', async () => {
    const session = makeSession({ events: twoCallFlow() });
    const tool = buildRecallTool();
    const exec = { agent: { session } };
    const span = textOf(await tool.execute({ start: 5, end: 0 }, exec as never));
    expect(span).toContain('firstCode()');
    expect(span).toContain('secondCode()');
    expect(span).toContain('out1');
    expect(span).toContain('out2');
  });

  it('系统消息不占 index 且不出现在召回结果', async () => {
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
    // 系统消息不占位，两条流程从 index 0 起
    const span = String(textOf(await tool.execute({ start: 0, end: 5 }, exec as never)));
    expect(span).not.toContain('宿主注入的工作区指令');
    expect(span).not.toContain('<sys');
    expect(span).toContain('<user_message index="0">');
    expect(span).toContain('<assistant index="5" type="toolcall" tool-name="run_code">');
  });

  it('offset 正数从 start 向后延伸', async () => {
    const session = makeSession({ events: twoCallFlow() });
    const tool = buildRecallTool();
    const exec = { agent: { session } };
    const span = textOf(await tool.execute({ start: 1, offset: 2 }, exec as never));
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
    const span = textOf(await tool.execute({ start: 5, offset: -2 }, exec as never));
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
    const up = textOf(await tool.execute({ start: 1, offset: 2.9 }, exec as never));
    expect(up).toContain('out1');
    expect(up).not.toContain('secondCode()');
    const down = textOf(await tool.execute({ start: 5, offset: -1.5 }, exec as never));
    expect(down).toContain('secondCode()');
    expect(down).toContain('out2');
    expect(down).not.toContain('out1');
    const zero = textOf(await tool.execute({ start: 5, offset: 0 }, exec as never));
    expect(zero).toContain('secondCode()'); // toolcall 条含调用参数与结果
    expect(zero).toContain('out2');
    expect(zero).not.toContain('firstCode()');
  });

  it('end 与 offset 同时给出时 end 优先', async () => {
    const session = makeSession({ events: twoCallFlow() });
    const tool = buildRecallTool();
    const exec = { agent: { session } };
    const span = textOf(await tool.execute({ start: 0, end: 5, offset: 0 }, exec as never));
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
    const badStart = textOf(await tool.execute({ start: 99, offset: 1 }, exec as never));
    expect(String(badStart)).toContain('start 99 越界');
    const badEnd = textOf(await tool.execute({ start: 0, end: 99 }, exec as never));
    expect(String(badEnd)).toContain('end 99 越界');
    const badNeg = textOf(await tool.execute({ start: -1, offset: 1 }, exec as never));
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
    const tool = buildRecallTool({
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
    const span = textOf(await tool.execute({ start: 2, offset: 0 }, exec as never));
    expect(String(span)).toContain('PRUNED-HEAD');
    expect(String(span)).not.toContain('X'.repeat(20000));
    const raw = textOf(await buildRecallTool().execute({ start: 2, offset: 0 }, exec as never));
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
    const result = textOf(
      await tool.execute({ start: 0, offset: 1 }, {
        agent: { session },
      } as never),
    );
    expect(String(result)).toContain('仅主会话可用');
  });
  it('带图用户消息：图片注释标注 + images 元数据随结果保留', async () => {
    const events = [
      {
        type: 'user/message',
        data: makeMessage({
          content: [textBlock('看图说话'), imageBlock({ name: '图.png' })],
          id: 'u-img',
        }),
      } as unknown as SessionEvent,
    ];
    const session = makeSession({ events });
    const tool = buildRecallTool();
    const value = (await tool.execute({ start: 0, offset: 0 }, {
      agent: { session },
    } as never)) as RecallOutputValue;
    expect(value.text).toContain('<user_message index="0">');
    expect(value.text).toContain('看图说话');
    expect(value.text).toContain('[图片附件：图.png（image/png 800×600，1024 bytes）]');
    expect(value.images).toEqual([
      {
        attachmentId: 'att-1',
        mediaType: 'image/png',
        bytes: 1024,
        width: 800,
        height: 600,
        name: '图.png',
      },
    ]);
  });

  it('纯图无字消息：条目仍输出，正文仅图片注释标注', async () => {
    const events = [
      {
        type: 'user/message',
        data: makeMessage({ content: [imageBlock()], id: 'u-img-only' }),
      } as unknown as SessionEvent,
    ];
    const session = makeSession({ events });
    const value = (await buildRecallTool().execute({ start: 0, offset: 0 }, {
      agent: { session },
    } as never)) as RecallOutputValue;
    expect(value.text).toContain('<user_message index="0">');
    expect(value.text).toContain('[图片附件（image/png 800×600，1024 bytes）]');
    expect(value.images).toHaveLength(1);
  });

  it('toolcall 结果 content 内的图片随结果保留（含 tool-result 嵌套）', async () => {
    const events = [
      {
        type: 'assistant/message',
        data: {
          message: makeMessage({
            role: 'assistant',
            content: [toolCallBlock('c9', 'run_code', JSON.stringify({ code: 'a()' }))],
            source: { kind: 'model', provider: 'test', model: 'test-model' },
            id: 'a-call',
          }),
        },
      } as unknown as SessionEvent,
      {
        type: 'tool/result',
        data: {
          message: {
            ...makeMessage({
              role: 'tool',
              content: [textBlock('r1'), imageBlock({ attachmentId: 'att-2' })],
              source: { kind: 'tool', callId: 'c9' },
              id: 't-r',
            }),
            toolCallId: 'c9',
            isError: false,
          },
        },
      } as unknown as SessionEvent,
    ];
    const session = makeSession({ events });
    const value = (await buildRecallTool().execute({ start: 0, offset: 0 }, {
      agent: { session },
    } as never)) as RecallOutputValue;
    expect(value.text).toContain('<assistant index="0" type="toolcall" tool-name="run_code">');
    expect(value.text).toContain('r1');
    expect(value.text).toContain('[图片附件（image/png 800×600，1024 bytes）]');
    expect(value.images).toEqual([
      { attachmentId: 'att-2', mediaType: 'image/png', bytes: 1024, width: 800, height: 600 },
    ]);
  });
});

describe('recall wire 参数 schema（由 zod 生成）', () => {
  /** buildRecallTool().parameters：zod schema 经 toJSONSchema 生成的 wire JSON Schema。 */
  const parameters = buildRecallTool().parameters;

  it('根为 type:object 的标准 JSON Schema，无 $schema/additionalProperties（官方 API 严格校验兼容）', () => {
    expect(parameters.type).toBe('object');
    expect(parameters).not.toHaveProperty('$schema');
    expect(parameters).not.toHaveProperty('additionalProperties');
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

describe('recall query 参数与 wire schema', () => {
  const enhanced = { semantic: {} };

  it('语义增强开关不影响 wire schema：恒含 query/top_k，start 不必填', () => {
    for (const tool of [buildRecallTool(), buildRecallTool(enhanced)]) {
      const properties = tool.parameters.properties as Record<string, unknown>;
      expect(Object.keys(properties).sort()).toEqual(['end', 'offset', 'query', 'start', 'top_k']);
      expect(tool.parameters.required ?? []).not.toContain('start');
    }
  });

  it('query 模式的参数解析', () => {
    expect(parseRecallArgs({ query: '找缓存逻辑' })).toEqual({ query: '找缓存逻辑' });
    expect(parseRecallArgs({ query: 'x', top_k: 5, start: 2, end: 5 })).toEqual({
      query: 'x',
      top_k: 5,
      start: 2,
      end: 5,
    });
    expect(() => parseRecallArgs({ query: '   ' })).toThrow(/query/);
    for (const topK of [0, 11, 2.5, '3']) {
      expect(() => parseRecallArgs({ query: 'x', top_k: topK })).toThrow(/top_k/);
    }
  });

  it('无 query 时按区间模式校验', () => {
    expect(() => parseRecallArgs({})).toThrow(/start/);
    expect(() => parseRecallArgs({ start: 1 })).toThrow(/end/);
  });

  it('增强开启时无 query 的区间调用与关闭时结果一致', async () => {
    const session = makeSession({ events: twoCallFlow() });
    const exec = { agent: { session } };
    const plain = textOf(await buildRecallTool().execute({ start: 0, end: 5 }, exec as never));
    const withSemantic = textOf(
      await buildRecallTool(enhanced).execute({ start: 0, end: 5 }, exec as never),
    );
    expect(withSemantic).toBe(plain);
  });

  it('描述随增强状态说明 query 的匹配方式', () => {
    expect(buildRecallTool().description).toContain('字符串匹配');
    expect(buildRecallTool(enhanced).description).toContain('含义');
    expect(buildRecallTool(enhanced).description).not.toContain('字符串匹配');
  });
});

describe('recall 字符串匹配（语义增强关闭）', () => {
  /** 执行一次不带语义增强的 query 检索，返回输出文本。 */
  async function search(args: object, callId?: string): Promise<string> {
    const session = makeSession({ events: twoCallFlow() });
    const exec = { agent: { session }, ...(callId === undefined ? {} : { callId }) };
    return String(textOf(await buildRecallTool().execute(args, exec as never)));
  }

  it('不区分大小写按命中词数排序，零命中不返回', async () => {
    const out = await search({ query: 'FIRSTCODE out1 nothing-here', top_k: 10 });
    expect(out).toContain('字符串匹配');
    expect(out).toContain('<assistant index="2" type="toolcall" tool-name="run_code">');
    expect(out).toContain('命中 2/3 个词: firstcode out1');
    expect(out).not.toContain('index="5"');
    expect(out).not.toContain('相似度');
  });

  it('同分时 index 大的优先', async () => {
    const out = await search({ query: 'run_code', top_k: 2 });
    const second = out.indexOf('index="5"');
    const first = out.indexOf('index="2"');
    expect(second).toBeGreaterThan(-1);
    expect(first).toBeGreaterThan(second);
  });

  it('区间限定检索范围', async () => {
    const out = await search({ query: 'run_code', start: 0, end: 3 });
    expect(out).toContain('检索区间 [0..3]');
    expect(out).toContain('index="2"');
    expect(out).not.toContain('index="5"');
  });

  it('排除本次调用自身的 toolcall', async () => {
    const out = await search({ query: 'run_code', top_k: 10 }, 'c2');
    expect(out).toContain('index="2"');
    expect(out).not.toContain('index="5"');
  });

  it('无命中时返回提示', async () => {
    expect(await search({ query: 'zzz-not-exist' })).toContain('未找到包含 zzz-not-exist');
  });
});
