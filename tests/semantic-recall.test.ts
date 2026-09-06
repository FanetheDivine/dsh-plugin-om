// semantic-recall.ts 单元测试：参数解析 parseSemanticRecallArgs、语义区间 resolveSemanticRange、
// 相似度匹配说明 matchExplanation、recall-semantic 工具行为与 wire 参数 schema。
import { describe, expect, it } from 'vitest';

import type { RecallOutputValue } from '../src/recall-output.ts';
import {
  buildSemanticRecallTool,
  matchExplanation,
  parseSemanticRecallArgs,
  resolveSemanticRange,
  SEMANTIC_MODEL_NOT_READY_MESSAGE,
} from '../src/semantic-recall.ts';
import type { SessionEvent } from '../src/types.ts';
import { imageBlock, makeMessage, makeSession, textBlock, textOf } from './helpers.ts';

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
    const span = textOf(await tool.execute({ query: '数据库 缓存' }, exec as never));
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
    const span = textOf(await tool.execute({ query: '数据库 缓存', top_k: 5 }, exec as never));
    const out = String(span);
    expect(out).toContain('权限校验逻辑');
    expect(out).toContain('日志输出格式');
    const top1 = textOf(await tool.execute({ query: '数据库 缓存', top_k: 1 }, exec as never));
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
    const span = textOf(await tool.execute({ query: '数据库', top_k: 3 }, exec as never));
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
    const span = textOf(
      await tool.execute({ query: '权限 数据库', start: 0, offset: 1 }, exec as never),
    );
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
    const span = textOf(await tool.execute({ query: '权限', start: 99, offset: 2 }, exec as never));
    const out = String(span);
    expect(out).toContain('已回退检索全部消息');
    expect(out).toContain('权限校验逻辑'); // 全量检索可见
  });

  it('范围描述：无区间时标注检索全部消息', async () => {
    const session = textSession([['m-auth', '权限校验逻辑']]);
    const tool = buildSemanticRecallTool({ embedder: fakeEmbedder() });
    const exec = { agent: { session } };
    const span = textOf(await tool.execute({ query: '权限' }, exec as never));
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
    const span = textOf(await tool.execute({ query: '数据库权限', top_k: 3 }, exec as never));
    const out = String(span);
    // 未裁剪时 20000 个 X 会溢出输出；裁剪后不出现
    expect(out).not.toContain('X'.repeat(20000));
  });

  it('subagent 会话调用被拒绝', async () => {
    const session = textSession([['m-db', '数据库配置']], { origin: 'subagent' });
    const tool = buildSemanticRecallTool({ embedder: fakeEmbedder() });
    const result = textOf(await tool.execute({ query: '数据库' }, { agent: { session } } as never));
    expect(String(result)).toContain('仅主会话可用');
  });

  it('无可检索消息返回提示', async () => {
    const session = makeSession({ events: [] });
    const tool = buildSemanticRecallTool({ embedder: fakeEmbedder() });
    const exec = { agent: { session } };
    const span = textOf(await tool.execute({ query: '数据库' }, exec as never));
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
    const result = textOf(await tool.execute({ query: '数据库' }, { agent: { session } } as never));
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
    const out = textOf(await tool.execute({ query: '数据库' }, { agent: { session } } as never));
    expect(out).toContain('数据库配置');
    expect(out).toContain('index 0 user'); // m-db 为完整消息 index 0
  });
  it('命中消息携带图片时随结果输出；描述注明只匹配文本', async () => {
    const tool = buildSemanticRecallTool({ embedder: fakeEmbedder() });
    expect(tool.description).toContain('只匹配文本');
    const events = [
      {
        type: 'user/message',
        data: makeMessage({
          content: [textBlock('数据库配置说明'), imageBlock({ attachmentId: 'att-3' })],
          id: 'm-db',
        }),
      } as unknown as SessionEvent,
    ];
    const session = makeSession({ events });
    const value = (await tool.execute({ query: '数据库' }, {
      agent: { session },
    } as never)) as RecallOutputValue;
    expect(value.text).toContain('数据库配置说明');
    expect(value.text).toContain('[图片附件（image/png 800×600，1024 bytes）]');
    expect(value.images).toEqual([
      { attachmentId: 'att-3', mediaType: 'image/png', bytes: 1024, width: 800, height: 600 },
    ]);
  });

  it('纯图片消息（无可渲染文本）不进候选池，无法被语义命中', async () => {
    const events = [
      {
        type: 'user/message',
        data: makeMessage({ content: [imageBlock()], id: 'm-img-only' }),
      } as unknown as SessionEvent,
      {
        type: 'user/message',
        data: makeMessage({ content: [textBlock('权限校验逻辑')], id: 'm-auth' }),
      } as unknown as SessionEvent,
    ];
    const session = makeSession({ events });
    const tool = buildSemanticRecallTool({ embedder: fakeEmbedder() });
    const value = (await tool.execute({ query: '权限' }, {
      agent: { session },
    } as never)) as RecallOutputValue;
    // 候选仅含可嵌入的文本消息（1 条），命中 m-auth；纯图片消息不占候选
    expect(value.text).toContain('1 条可嵌入');
    expect(value.text).toContain('权限校验逻辑');
    expect(value.images).toEqual([]);
  });
});

describe('recall-semantic wire 参数 schema（由 zod 生成）', () => {
  /** buildSemanticRecallTool().parameters：zod schema 经 toJSONSchema 生成的 wire JSON Schema。 */
  const parameters = buildSemanticRecallTool().parameters;

  it('根为 type:object 的标准 JSON Schema，无 $schema/additionalProperties（官方 API 严格校验兼容）', () => {
    expect(parameters.type).toBe('object');
    expect(parameters).not.toHaveProperty('$schema');
    expect(parameters).not.toHaveProperty('additionalProperties');
  });
});
