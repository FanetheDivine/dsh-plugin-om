// recall.ts 单元测试：recall 工具行为（start/end/offset 区间、pruner 裁剪、subagent 拒绝、
// 图片附件）、wire 参数 schema 与参数校验 parseRecallArgs。
import { describe, expect, it } from 'vitest';
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
  toolResultBlock,
  twoCallFlow,
} from './helpers.ts';

describe('recall 工具', () => {
  it('start+end 返回区间内全部完整消息（含代码与结果），输出标 index/类型', async () => {
    const session = makeSession({ events: twoCallFlow() });
    const tool = buildRecallTool();
    const exec = { agent: { session } };
    const span = textOf(await tool.execute({ start: 0, end: 5 }, exec as never));
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
    const span = textOf(await tool.execute({ start: 5, end: 0 }, exec as never));
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
    const span = textOf(await tool.execute({ start: 0, end: 6 }, exec as never));
    expect(String(span)).toContain('-- [index 0] sys --');
    expect(String(span)).toContain('宿主注入的工作区指令'); // sys 显示原文
    expect(String(span)).toContain('-- [index 1] user --');
    expect(String(span)).toContain('-- [index 6] toolcall callId=c2 --');
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
  it('带图用户消息：文本标注行 + images 元数据随结果保留', async () => {
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
    expect(value.text).toContain('-- [index 0] user --');
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

  it('纯图无字消息：条目仍输出，正文仅图片标注行', async () => {
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
    expect(value.text).toContain('-- [index 0] user --');
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
          message: makeMessage({
            content: [
              toolResultBlock('c9', [textBlock('r1'), imageBlock({ attachmentId: 'att-2' })]),
            ],
            source: { kind: 'tool', callId: 'c9' },
            id: 't-r',
          }),
        },
      } as unknown as SessionEvent,
    ];
    const session = makeSession({ events });
    const value = (await buildRecallTool().execute({ start: 0, offset: 0 }, {
      agent: { session },
    } as never)) as RecallOutputValue;
    expect(value.text).toContain('-- [index 0] toolcall callId=c9 --');
    expect(value.text).toContain('r1');
    expect(value.text).toContain('[图片附件（image/png 800×600，1024 bytes）]');
    expect(value.images).toEqual([
      { attachmentId: 'att-2', mediaType: 'image/png', bytes: 1024, width: 800, height: 600 },
    ]);
  });

  it('描述说明按 index 区间返回', () => {
    expect(buildRecallTool().description).toContain(
      '按 index 区间精确返回区间内全部完整消息的内容',
    );
  });
});

describe('recall wire 参数 schema（由 zod 生成）', () => {
  /** buildRecallTool().parameters：zod schema 经 toJSONSchema 生成的 wire JSON Schema。 */
  const parameters = buildRecallTool().parameters;
  /** properties（recall 的三个字段）。 */
  const properties = parameters.properties as Record<
    string,
    { type?: string; description?: string }
  >;

  it('根为 type:object 的标准 JSON Schema，无 $schema/additionalProperties（官方 API 严格校验兼容）', () => {
    expect(parameters.type).toBe('object');
    expect(parameters).not.toHaveProperty('$schema');
    expect(parameters).not.toHaveProperty('additionalProperties');
  });

  it('properties 含 start/end/offset（number），required 仅 start', () => {
    expect(properties.start?.type).toBe('number');
    expect(properties.end?.type).toBe('number');
    expect(properties.offset?.type).toBe('number');
    expect(parameters.required).toEqual(['start']);
  });

  it('描述来自 .describe() 且透传 refine 约束说明', () => {
    expect(properties.start?.description).toContain('end 与 offset 至少提供一个');
    expect(properties.start?.description).toContain('end 优先');
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
