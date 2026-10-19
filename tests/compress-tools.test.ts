// 压缩状态机行为：历史查看、二次确认与区间替换、原始 ask 重写和完成门禁，
// 验证双路径切换、参数校验、仅 q/a 的保留产物及历史反思兼容。
import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_SUMMARY_MAX_CHARS,
  ARCHIVE_SUMMARY_SOFT_CHARS,
  CompressionState,
} from '../src/compress-tools.ts';
import {
  buildArchiveView,
  buildReflectView,
  type CompressionView,
  type ViewEntry,
} from '../src/compress-view.ts';
import {
  ARCHIVED_HISTORY_TAG,
  COMPLETE_MESSAGE_DEFINITION,
  HISTORY_TAG,
  HISTORY_TIP,
  historyFormatNote,
} from '../src/constants.ts';

/** 由条目列表推导视图区间（与生产 viewBounds 同规则）。 */
function viewOf(entries: ViewEntry[]): CompressionView {
  let minIndex: number | undefined;
  let maxIndex: number | undefined;
  for (const entry of entries) {
    if (entry.lo === undefined || entry.hi === undefined) continue;
    if (minIndex === undefined || entry.lo < minIndex) minIndex = entry.lo;
    if (maxIndex === undefined || entry.hi > maxIndex) maxIndex = entry.hi;
  }
  return {
    entries,
    ...(minIndex === undefined ? {} : { minIndex }),
    ...(maxIndex === undefined ? {} : { maxIndex }),
  };
}

/** 观察风格视图：0 用户 / 1-4 assistant / 5 用户 / 6-7 assistant。 */
function observeView(overrides: ViewEntry[] = []): CompressionView {
  const base: ViewEntry[] = [
    { kind: 'user', lo: 0, hi: 0, text: '用户消息A' },
    { kind: 'assistant', lo: 1, hi: 1, text: '助手A2' },
    { kind: 'assistant', lo: 2, hi: 2, text: '助手B' },
    { kind: 'assistant', lo: 3, hi: 3, text: '助手C', toolName: 'run_code' },
    { kind: 'assistant', lo: 4, hi: 4, text: '助手D' },
    { kind: 'user', lo: 5, hi: 5, text: '用户消息E' },
    { kind: 'assistant', lo: 6, hi: 6, text: '助手F' },
    { kind: 'assistant', lo: 7, hi: 7, text: '助手G' },
    ...overrides,
  ];
  return viewOf(base);
}

/** 原始合法提问：包含两题、完整选项与空答案。 */
function originalAsk(index = 1): ViewEntry {
  return {
    kind: 'assistant',
    lo: index,
    hi: index,
    text: '<ask-user-question>q:采用哪种发布方式？\no1:灰度发布 — 先向少量用户开放\no2:全量发布 — 一次向所有用户开放\na:第一个\nq:是否指定日期？\na:(未回答)</ask-user-question>',
    toolName: 'ask_user_question',
    ask: {
      questions: [
        {
          question: '采用哪种发布方式？',
          options: [
            { label: '灰度发布', description: '先向少量用户开放' },
            { label: '全量发布', description: '一次向所有用户开放' },
          ],
          answer: '第一个',
        },
        { question: '是否指定日期？', options: [], answer: '(未回答)' },
      ],
    },
  };
}

/** 重写整次提问的工具参数。 */
function rewriteArgs(index = 1) {
  return {
    index,
    qa: [
      { ordinal: 1, q: '采用哪种发布方式？', a: '采用灰度发布，先向少量用户开放。' },
      { ordinal: 2, q: '是否指定日期？', a: '(未回答)' },
    ],
  };
}

/** 使用真实工具分发提交重写。 */
function rewrite(state: CompressionState, args = rewriteArgs()) {
  return state.executeCall('rewriteAskUserQuestion', JSON.stringify(args));
}

describe('原始 ask 的直接压缩', () => {
  it('首次阻止后再次覆盖生成普通摘要，无需重写', () => {
    const state = new CompressionState(
      viewOf([originalAsk(), { kind: 'assistant', lo: 2, hi: 2, text: '执行灰度发布' }]),
    );
    expect(
      state.compressHistory({ start: 1, end: 2, content: '确认采用灰度发布并执行' }).isError,
    ).toBe(true);
    expect(state.replacementCount).toBe(0);
    expect(state.compressHistory({ index: 1, content: '确认采用灰度发布' }).isError).toBe(false);
    expect(state.complete().isError).toBe(false);
    const final = state.buildFinalBlock();
    expect(final).toContain('<assistant index="1"><![CDATA[确认采用灰度发布]]></assistant>');
    expect(final).not.toContain('<ask-user-question');
    expect(final).not.toContain('表示向用户提问');
  });

  it('失败 ask 是普通 toolcall，不触发确认或 ask 格式说明', () => {
    const entry: ViewEntry = {
      kind: 'assistant',
      lo: 1,
      hi: 1,
      text: '失败的调用',
      toolName: 'ask_user_question',
      toolArgs: '{"questions":[{"id":"q","question":"继续吗"}]}',
      toolResult: 'Error: ask_user_question was aborted before the user answered',
    };
    const state = new CompressionState(viewOf([entry]));
    const before = state.buildFinalBlock();
    expect(before).toContain('type="toolcall" tool-name="ask_user_question"');
    expect(before).not.toContain('表示向用户提问');
    expect(state.compressHistory({ index: 1, content: '用户中止提问' }).isError).toBe(false);
    expect(state.complete().isError).toBe(false);
    expect(state.buildFinalBlock()).toContain(
      '<assistant index="1"><![CDATA[用户中止提问]]></assistant>',
    );
  });
});

describe('rewriteAskUserQuestion', () => {
  it('只允许重写成功 getHistory 已返回的原始 ask', () => {
    const state = new CompressionState(viewOf([originalAsk(1), originalAsk(3)]));
    expect(rewrite(state).isError).toBe(true);
    expect(state.getHistory({ start: -1, end: 1 }).isError).toBe(true);
    expect(rewrite(state).isError).toBe(true);
    expect(state.getHistory({ start: 1, end: 1 }).text).toContain('o1:灰度发布');
    expect(rewrite(state).isError).toBe(true);
    state.markHistoryDelivered();
    expect(rewrite(state).isError).toBe(false);
    expect(rewrite(state, rewriteArgs(3)).isError).toBe(true);
    expect(state.getHistory({ start: 3, end: 3 }).isError).toBe(false);
    expect(rewrite(state, rewriteArgs(3)).isError).toBe(true);
    state.markHistoryDelivered();
    expect(rewrite(state, rewriteArgs(3)).isError).toBe(false);
  });

  it.each(['q', 'a'] as const)('拒绝 %s 中的选项列表行且不修改已重写结果', (field) => {
    const state = new CompressionState(viewOf([originalAsk()]));
    state.getHistory({});
    state.markHistoryDelivered();
    expect(rewrite(state).isError).toBe(false);
    const previous = state.buildFinalBlock();
    const args = rewriteArgs();
    const first = args.qa[0];
    if (!first) throw new Error('Expected question');
    first[field] += '\n  o1:灰度发布\n\to2:全量发布';
    expect(rewrite(state, args).isError).toBe(true);
    expect(state.complete().isError).toBe(false);
    expect(state.buildFinalBlock()).toBe(previous);
    expect(previous).not.toContain('o1:');
  });

  it('严校验参数形态、目标、全部题序和纯文本字段', () => {
    const state = new CompressionState(
      viewOf([
        originalAsk(1),
        { kind: 'assistant', lo: 2, hi: 2, text: '普通消息' },
        {
          kind: 'assistant',
          lo: 4,
          hi: 4,
          text: '<ask-user-question>q:旧题 a:旧答</ask-user-question>',
          toolName: 'ask_user_question',
          blockSeq: 10,
        },
      ]),
    );
    expect(state.getHistory({}).isError).toBe(false);
    state.markHistoryDelivered();
    const valid = rewriteArgs();
    const first = valid.qa[0];
    const second = valid.qa[1];
    const badArgs = [
      null,
      [],
      'text',
      { index: 1 },
      { ...valid, index: 1.5 },
      { ...valid, index: -1 },
      { ...valid, index: '1' },
      { ...valid, index: 3 },
      { ...valid, index: 2 },
      { ...valid, index: 4 },
      { ...valid, extra: true },
      { ...valid, options: [] },
      { ...valid, qa: [] },
      { ...valid, qa: [first] },
      { ...valid, qa: [first, first] },
      { ...valid, qa: [{ ...first, ordinal: 0 }, second] },
      { ...valid, qa: [{ ...first, ordinal: 1.5 }, second] },
      { ...valid, qa: [{ ...first, ordinal: '1' }, second] },
      { ...valid, qa: [{ ...first, ordinal: 3 }, second] },
      { ...valid, qa: [null, second] },
      { ...valid, qa: [{ ...first, q: '' }, second] },
      { ...valid, qa: [{ ...first, a: '   ' }, second] },
      { ...valid, qa: [{ ...first, a: 42 }, second] },
      { ...valid, qa: [{ ...first, q: '<![CDATA[题]]>' }, second] },
      { ...valid, qa: [{ ...first, a: '<![CDATA[答]]>' }, second] },
      { ...valid, qa: [{ ...first, options: [] }, second] },
      { ...valid, qa: [{ ...first, extra: 'unknown' }, second] },
    ];
    for (const args of badArgs) {
      const result = state.executeCall('rewriteAskUserQuestion', JSON.stringify(args));
      expect(result.isError, JSON.stringify(args)).toBe(true);
    }
    expect(state.executeCall('rewriteAskUserQuestion', 'not-json').isError).toBe(true);
    expect(rewrite(state).isError).toBe(false);
  });

  it('有效重提整体替换，无效提交不改变成功结果，查看仍返回原始 options', () => {
    const state = new CompressionState(viewOf([originalAsk()]));
    state.getHistory({});
    state.markHistoryDelivered();
    expect(rewrite(state).isError).toBe(false);
    const initial = state.buildFinalBlock();
    expect(initial).toContain('a:采用灰度发布，先向少量用户开放。');
    const replacement = rewriteArgs();
    replacement.qa[0] = { ordinal: 1, q: '发布策略？', a: '灰度发布，先开放给少量用户。' };
    expect(rewrite(state, replacement).isError).toBe(false);
    const after = state.buildFinalBlock();
    expect(after).toContain('q:发布策略？');
    expect(after).not.toContain('a:采用灰度发布，先向少量用户开放。');
    expect(
      state.executeCall(
        'rewriteAskUserQuestion',
        JSON.stringify({ ...replacement, qa: [replacement.qa[0]] }),
      ).isError,
    ).toBe(true);
    expect(state.buildFinalBlock()).toBe(after);
    expect(state.getHistory({}).text).toContain('o2:全量发布');
    expect(state.getHistory({}).text).toContain('a:第一个');
  });

  it('保留逐题 q/a 与 index，不输出 options，并支持 XML字面文本和 CDATA闭合字符', () => {
    const state = new CompressionState(viewOf([originalAsk()]));
    state.getHistory({});
    state.markHistoryDelivered();
    const args = rewriteArgs();
    args.qa[0] = {
      ordinal: 1,
      q: '保留 <xml>、比较 x < y\n及换行？',
      a: '保留 & 和 a]]>b\n文字。',
    };
    expect(rewrite(state, args).isError).toBe(false);
    expect(state.complete().isError).toBe(false);
    const block = state.buildFinalBlock();
    expect(block).toContain('<ask-user-question index="1">');
    expect(block).toContain('q:保留 <xml>、比较 x < y\n及换行？');
    expect(block).toContain('a:保留 & 和 a]]><![CDATA[]]]]><![CDATA[>b\n文字。');
    expect(block).toContain('q:是否指定日期？\na:(未回答)');
    expect(block).not.toContain('o1:');
    expect(block).not.toContain('o2:');
    expect(block).not.toContain('全量发布');
    const reflect = new CompressionState(buildReflectView([{ text: block, seq: 10 }]));
    expect(reflect.complete().isError).toBe(false);
    expect(reflect.buildFinalBlock()).toBe(block);
    expect(reflect.compressHistory({ index: 1, content: '旧问答摘要' }).isError).toBe(true);
    expect(reflect.compressHistory({ index: 1, content: '旧问答摘要' }).isError).toBe(false);
  });
});

describe('原始 ask 路径切换', () => {
  it('首次压缩阻止后可以改走重写', () => {
    const state = new CompressionState(viewOf([originalAsk()]));
    expect(state.compressHistory({ index: 1, content: '问答摘要' }).isError).toBe(true);
    state.getHistory({});
    state.markHistoryDelivered();
    expect(rewrite(state).isError).toBe(false);
    expect(state.complete().isError).toBe(false);
    expect(state.buildFinalBlock()).toContain('<ask-user-question index="1">');
  });

  it('重写后直接压缩仍先阻止再放行，覆盖后拒绝重写且仅输出摘要', () => {
    const state = new CompressionState(
      viewOf([originalAsk(1), { kind: 'assistant', lo: 2, hi: 2, text: '后续执行' }]),
    );
    state.getHistory({});
    state.markHistoryDelivered();
    expect(rewrite(state).isError).toBe(false);
    expect(state.compressHistory({ start: 1, end: 2, content: '最终摘要' }).isError).toBe(true);
    expect(state.buildFinalBlock()).toContain('<ask-user-question index="1">');
    expect(state.compressHistory({ start: 1, end: 2, content: '最终摘要' }).isError).toBe(false);
    expect(rewrite(state).isError).toBe(true);
    expect(state.complete().isError).toBe(false);
    const block = state.buildFinalBlock();
    expect(block).toContain('<assistant start="1" end="2"><![CDATA[最终摘要]]></assistant>');
    expect(block).not.toContain('<ask-user-question');
    expect(block).not.toContain('采用灰度发布');
  });
});

describe('原始 ask 完成门禁', () => {
  it('未处理或仅首次阻止不能完成，构建同样拒绝', () => {
    const state = new CompressionState(viewOf([originalAsk(1), originalAsk(3)]));
    const first = state.complete();
    expect(first.isError).toBe(true);
    expect(first.text).toContain('1');
    expect(first.text).toContain('3');
    expect(state.completed).toBe(false);
    expect(() => state.buildFinalBlock()).toThrow();
    expect(state.compressHistory({ index: 1, content: '摘要' }).isError).toBe(true);
    state.getHistory({ start: 3, end: 3 });
    state.markHistoryDelivered();
    expect(rewrite(state, rewriteArgs(3)).isError).toBe(false);
    const pending = state.executeCall('completeCompression', '{}');
    expect(pending.isError).toBe(true);
    expect(pending.text).toContain('1');
    expect(state.completed).toBe(false);
    expect(() => state.buildFinalBlock()).toThrow();
    expect(state.compressHistory({ index: 1, content: '摘要' }).isError).toBe(false);
    expect(state.complete().isError).toBe(false);
    expect(state.buildFinalBlock()).toContain('<assistant index="1"><![CDATA[摘要]]></assistant>');
    expect(state.buildFinalBlock()).toContain('<ask-user-question index="3">');
  });
});

describe('原始 ask 处理计数', () => {
  it('原始 ask 存在标记恒定，重写计数只包含未被覆盖的成功结果', () => {
    const state = new CompressionState(viewOf([originalAsk(1), originalAsk(3)]));
    expect(state.hasPendingAsks).toBe(true);
    expect(state.rewriteCount).toBe(0);
    state.getHistory({});
    state.markHistoryDelivered();
    expect(rewrite(state).isError).toBe(false);
    expect(state.rewriteCount).toBe(1);
    expect(rewrite(state).isError).toBe(false);
    expect(state.rewriteCount).toBe(1);
    expect(rewrite(state, rewriteArgs(3)).isError).toBe(false);
    expect(state.rewriteCount).toBe(2);
    expect(state.compressHistory({ index: 1, content: '直接摘要' }).isError).toBe(true);
    expect(state.rewriteCount).toBe(2);
    expect(state.compressHistory({ index: 1, content: '直接摘要' }).isError).toBe(false);
    expect(state.rewriteCount).toBe(1);
    expect(state.hasPendingAsks).toBe(true);
    expect(state.complete().isError).toBe(false);
    expect(state.hasPendingAsks).toBe(true);
    const historical = new CompressionState(
      buildReflectView([{ text: state.buildFinalBlock(), seq: 10 }]),
    );
    expect(historical.hasPendingAsks).toBe(false);
    expect(historical.rewriteCount).toBe(0);
    expect(historical.complete().isError).toBe(false);
  });
});

describe('getHistory', () => {
  it('start/end 缺省返回要求区间全部条目，无注释头，无 history 包裹', () => {
    const state = new CompressionState(observeView());
    const result = state.getHistory({});
    expect(result.isError).toBe(false);
    expect(result.text).not.toContain('<!--');
    expect(result.text.startsWith('<user_message index="0">')).toBe(true);
    expect(result.text).toContain('<user_message index="0"><![CDATA[用户消息A]]></user_message>');
    expect(result.text).not.toContain(`<${HISTORY_TAG}`);
  });

  it('指定区间只返回相交条目', () => {
    const state = new CompressionState(observeView());
    const result = state.getHistory({ start: 2, end: 4 });
    expect(result.isError).toBe(false);
    expect(result.text).toContain('index="2"');
    expect(result.text).not.toContain('index="0"');
    expect(result.text).not.toContain('index="6"');
  });

  it('start/end 越界或 start > end 返回错误', () => {
    const state = new CompressionState(observeView());
    expect(state.getHistory({ start: -1 }).isError).toBe(true);
    expect(state.getHistory({ end: 8 }).isError).toBe(true);
    expect(state.getHistory({ start: 4, end: 2 }).isError).toBe(true);
    expect(state.getHistory({ start: 'x' }).isError).toBe(true);
  });

  it('区间切入已有压缩块时返回整块全部条目', () => {
    const view = viewOf([
      { kind: 'user', lo: 0, hi: 0, text: 'U', blockSeq: 10 },
      { kind: 'assistant', lo: 1, hi: 3, text: '块1摘要', blockSeq: 10 },
      { kind: 'assistant', lo: 4, hi: 5, text: '块2摘要', blockSeq: 20 },
    ]);
    const state = new CompressionState(view);
    // 区间 [2..4] 同时切入两个块 → 两个块全部条目返回
    const result = state.getHistory({ start: 2, end: 4 });
    expect(result.isError).toBe(false);
    expect(result.text).toContain('index="0"');
    expect(result.text).toContain('start="1" end="3"');
    expect(result.text).toContain('start="4" end="5"');
  });

  it('无可定位条目时返回错误', () => {
    const state = new CompressionState(viewOf([{ kind: 'assistant', text: '遗留' }]));
    expect(state.getHistory({}).isError).toBe(true);
  });
});

describe('getHistory 当前状态', () => {
  it('压缩后被替换条目显示为摘要并位于原位置，无注释头', () => {
    const state = new CompressionState(observeView());
    expect(state.compressHistory({ start: 1, end: 2, content: '摘要A2-B' }).isError).toBe(false);
    expect(state.compressHistory({ index: 4, content: '摘要D' }).isError).toBe(false);
    const text = state.getHistory({}).text;
    expect(text).not.toContain('<!--');
    expect(text.startsWith('<user_message index="0">')).toBe(true);
    const order = [
      '<user_message index="0">',
      '<assistant start="1" end="2"><![CDATA[摘要A2-B]]></assistant>',
      '<assistant index="3"><![CDATA[助手C]]></assistant>',
      '<assistant index="4"><![CDATA[摘要D]]></assistant>',
      '<user_message index="5">',
    ].map((part) => text.indexOf(part));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).not.toContain('助手A2');
    expect(text).not.toContain('助手B');
    expect(text).not.toContain('助手D');
  });

  it('查询区间与摘要相交时返回整条摘要，不相交时不返回', () => {
    const state = new CompressionState(observeView());
    expect(state.compressHistory({ start: 1, end: 4, content: '摘要1-4' }).isError).toBe(false);
    const hit = state.getHistory({ start: 3, end: 3 });
    expect(hit.text.startsWith('<assistant start="1" end="4">')).toBe(true);
    expect(hit.text).toContain('<assistant start="1" end="4"><![CDATA[摘要1-4]]></assistant>');
    const miss = state.getHistory({ start: 5, end: 7 });
    expect(miss.text).not.toContain('<!--');
    expect(miss.text).not.toContain('摘要1-4');
  });

  it('覆盖后只显示最新摘要', () => {
    const state = new CompressionState(observeView());
    expect(state.compressHistory({ start: 2, end: 3, content: '旧摘要' }).isError).toBe(false);
    expect(state.compressHistory({ start: 1, end: 4, content: '新摘要' }).isError).toBe(false);
    const text = state.getHistory({}).text;
    expect(text).not.toContain('<!--');
    expect(text).toContain('<assistant start="1" end="4"><![CDATA[新摘要]]></assistant>');
    expect(text).not.toContain('旧摘要');
    expect(state.compressHistory({ start: 1, end: 4, content: '再次修正' }).isError).toBe(false);
    expect(state.getHistory({}).text).not.toContain('新摘要');
    expect(state.getHistory({}).text).toContain('再次修正');
  });

  it('重写的提问仍显示原题、选项和回答，被直接压缩的提问显示为摘要', () => {
    const state = new CompressionState(
      viewOf([
        originalAsk(1),
        { kind: 'assistant', lo: 2, hi: 2, text: '执行灰度发布' },
        originalAsk(3),
      ]),
    );
    state.getHistory({});
    state.markHistoryDelivered();
    expect(rewrite(state).isError).toBe(false);
    expect(state.compressHistory({ start: 2, end: 3, content: '执行并再次确认' }).isError).toBe(
      true,
    );
    expect(state.compressHistory({ start: 2, end: 3, content: '执行并再次确认' }).isError).toBe(
      false,
    );
    const text = state.getHistory({}).text;
    expect(text).not.toContain('<!--');
    expect(text).toContain('o2:全量发布');
    expect(text).toContain('a:第一个');
    expect(text).not.toContain('采用灰度发布，先向少量用户开放。');
    expect(text).toContain('<assistant start="2" end="3"><![CDATA[执行并再次确认]]></assistant>');
    expect(state.complete().isError).toBe(false);
    expect(state.buildFinalBlock()).toContain('a:采用灰度发布，先向少量用户开放。');
  });

  it('reasoning 随所属条目消失：带 index 的看自身区间，无 index 的跟随其后第一条条目', () => {
    const observe = new CompressionState(
      viewOf([
        { kind: 'user', lo: 0, hi: 0, text: 'U' },
        { kind: 'reasoning', lo: 1, hi: 1, text: '思考甲' },
        { kind: 'assistant', lo: 1, hi: 1, text: '助手甲' },
        { kind: 'reasoning', lo: 2, hi: 2, text: '思考乙' },
        { kind: 'assistant', lo: 2, hi: 2, text: '助手乙' },
      ]),
    );
    expect(observe.compressHistory({ index: 1, content: '甲摘要' }).isError).toBe(false);
    const observed = observe.getHistory({}).text;
    expect(observed).not.toContain('思考甲');
    expect(observed).toContain('思考乙');
    const reflect = new CompressionState(
      viewOf([
        { kind: 'user', lo: 0, hi: 0, text: 'U', blockSeq: 10 },
        { kind: 'reasoning', text: '块内思考甲', blockSeq: 10 },
        { kind: 'assistant', lo: 1, hi: 3, text: '块内摘要甲', blockSeq: 10 },
        { kind: 'reasoning', text: '块内思考乙', blockSeq: 10 },
        { kind: 'assistant', lo: 4, hi: 4, text: '块内摘要乙', blockSeq: 10 },
      ]),
    );
    expect(reflect.compressHistory({ start: 1, end: 3, content: '合并摘要' }).isError).toBe(false);
    const reflected = reflect.getHistory({}).text;
    expect(reflected).not.toContain('块内思考甲');
    expect(reflected).toContain('块内思考乙');
    expect(reflected.indexOf('U]]>')).toBeLessThan(reflected.indexOf('合并摘要'));
    expect(reflected.indexOf('合并摘要')).toBeLessThan(reflected.indexOf('块内思考乙'));
  });

  it('切入已有块时返回该块当前条目，跨块摘要连带展开其覆盖的全部块', () => {
    const state = new CompressionState(
      viewOf([
        { kind: 'user', lo: 0, hi: 0, text: 'U0', blockSeq: 10 },
        { kind: 'assistant', lo: 1, hi: 2, text: '块1摘要甲', blockSeq: 10 },
        { kind: 'assistant', lo: 3, hi: 4, text: '块1摘要乙', blockSeq: 10 },
        { kind: 'assistant', lo: 5, hi: 6, text: '块2摘要', blockSeq: 20 },
        { kind: 'user', lo: 7, hi: 7, text: 'U7', blockSeq: 20 },
        { kind: 'assistant', lo: 8, hi: 9, text: '块3摘要', blockSeq: 30 },
      ]),
    );
    expect(state.compressHistory({ start: 3, end: 6, content: '跨块合并' }).isError).toBe(false);
    const head = state.getHistory({ start: 0, end: 0 }).text;
    expect(head).not.toContain('<!--');
    for (const part of ['U0', '块1摘要甲', '跨块合并', 'U7']) expect(head).toContain(part);
    for (const part of ['块1摘要乙', '块2摘要', '块3摘要']) expect(head).not.toContain(part);
    const tail = state.getHistory({ start: 8, end: 9 }).text;
    expect(tail).not.toContain('<!--');
    expect(tail).toContain('块3摘要');
  });

  it('查看全区间与最终块条目一致', () => {
    const state = new CompressionState(observeView());
    expect(state.compressHistory({ start: 1, end: 2, content: '摘要甲' }).isError).toBe(false);
    expect(state.compressHistory({ index: 6, content: '摘要乙' }).isError).toBe(false);
    const body = state.getHistory({}).text;
    const block = state.buildFinalBlock();
    const prefix = `<${HISTORY_TAG} tip="${HISTORY_TIP}">\n${historyFormatNote({ user: true })}\n`;
    const suffix = `\n</${HISTORY_TAG}>`;
    expect(block.startsWith(prefix)).toBe(true);
    expect(block.endsWith(suffix)).toBe(true);
    expect(body).toBe(block.slice(prefix.length, -suffix.length));
  });
});

describe('compressHistory 参数校验', () => {
  it('index 与 start/end 同时提供、都不提供、start 无 end 均报错', () => {
    const state = new CompressionState(observeView());
    expect(state.compressHistory({ index: 2, start: 2, end: 3, content: 'x' }).isError).toBe(true);
    expect(state.compressHistory({ content: 'x' }).isError).toBe(true);
    expect(state.compressHistory({ start: 2, content: 'x' }).isError).toBe(true);
    expect(state.compressHistory({ end: 3, content: 'x' }).isError).toBe(true);
  });

  it('index / start / end 非法数值与空 content 报错', () => {
    const state = new CompressionState(observeView());
    expect(state.compressHistory({ index: 1.5, content: 'x' }).isError).toBe(true);
    expect(state.compressHistory({ index: -1, content: 'x' }).isError).toBe(true);
    expect(state.compressHistory({ start: 2, end: 1, content: 'x' }).isError).toBe(true);
    expect(state.compressHistory({ start: 2.5, end: 3, content: 'x' }).isError).toBe(true);
    expect(state.compressHistory({ index: 2, content: '' }).isError).toBe(true);
    expect(state.compressHistory({ index: 2, content: '   ' }).isError).toBe(true);
    expect(state.compressHistory({ index: 2 }).isError).toBe(true);
  });

  it('区间越界报错', () => {
    const state = new CompressionState(observeView());
    expect(state.compressHistory({ index: 8, content: 'x' }).isError).toBe(true);
    expect(state.compressHistory({ start: 0, end: 9, content: 'x' }).isError).toBe(true);
  });

  it('覆盖用户消息报错', () => {
    const state = new CompressionState(observeView());
    const userHit = state.compressHistory({ start: 0, end: 2, content: 'x' });
    expect(userHit.isError).toBe(true);
    expect(userHit.text).toContain('用户消息');
  });

  it('与 assistant 区间条目部分重叠报错，完整包含成功', () => {
    const view = viewOf([
      { kind: 'user', lo: 0, hi: 0, text: 'U' },
      { kind: 'assistant', lo: 1, hi: 3, text: '区间条目' },
    ]);
    const state = new CompressionState(view);
    expect(state.compressHistory({ start: 2, end: 3, content: 'x' }).isError).toBe(true);
    expect(state.compressHistory({ start: 1, end: 3, content: '整体压缩' }).isError).toBe(false);
  });

  it('区间内没有可压缩的 assistant 条目报错', () => {
    // 视图存在空隙：index 3 无任何条目（0/2/4 有条目）
    const view = viewOf([
      { kind: 'user', lo: 0, hi: 0, text: 'U' },
      { kind: 'assistant', lo: 2, hi: 2, text: 'A' },
      { kind: 'user', lo: 4, hi: 4, text: 'V' },
    ]);
    const state = new CompressionState(view);
    const result = state.compressHistory({ start: 3, end: 3, content: 'x' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('没有可压缩');
  });
});

describe('compressHistory 替换与重叠规则', () => {
  it('start==end 等同 index，成功记录替换', () => {
    const state = new CompressionState(observeView());
    const r1 = state.compressHistory({ start: 2, end: 2, content: '压缩B' });
    expect(r1.isError).toBe(false);
    expect(state.replacementCount).toBe(1);
  });

  it('与已有替换区间部分重叠报错并指出该区间，相同或更大的区间覆盖成功', () => {
    const state = new CompressionState(observeView());
    expect(state.compressHistory({ start: 2, end: 3, content: 'A' }).isError).toBe(false);
    // [1..2] 与 [2..3] 部分重叠 → 报错并指出已有区间；落在区间内的单条 index 同样报错
    const crossed = state.compressHistory({ start: 1, end: 2, content: 'B' });
    expect(crossed.isError).toBe(true);
    expect(crossed.text).toContain('[2..3]');
    expect(state.compressHistory({ index: 3, content: 'probe' }).isError).toBe(true);
    // 相同区间重复提交 → 覆盖自身
    expect(state.compressHistory({ start: 2, end: 3, content: 'C' }).isError).toBe(false);
    expect(state.replacementCount).toBe(1);
    // [1..4] 完全包含 [2..3] → 覆盖
    expect(state.compressHistory({ start: 1, end: 4, content: 'D' }).isError).toBe(false);
    expect(state.replacementCount).toBe(1);
    // 不相交区间正常追加
    expect(state.compressHistory({ start: 6, end: 7, content: 'E' }).isError).toBe(false);
    expect(state.replacementCount).toBe(2);
    const block = state.buildFinalBlock();
    expect(block).toContain('<assistant start="1" end="4"><![CDATA[D]]></assistant>');
    expect(block).not.toContain('probe');
  });

  it('skill 块首次覆盖被拒绝并要求重新思考，再次覆盖直接执行', () => {
    const view = observeView([
      { kind: 'assistant', lo: 8, hi: 8, text: 'skill 加载', toolName: 'skill' },
    ]);
    const state = new CompressionState(view);
    const first = state.compressHistory({ start: 8, end: 8, content: '压缩skill' });
    expect(first.isError).toBe(true);
    expect(first.text).toContain('skill');
    expect(first.text).toContain('重新思考');
    expect(state.replacementCount).toBe(0);
    // 换一个覆盖同一 skill 块的区间（挑战按块记忆）→ 直接执行
    const second = state.compressHistory({ index: 8, content: '压缩skill' });
    expect(second.isError).toBe(false);
    expect(state.replacementCount).toBe(1);
  });

  it('非 skill 工具调用不触发二次确认', () => {
    const state = new CompressionState(observeView());
    const result = state.compressHistory({ index: 3, content: '压缩C' });
    expect(result.isError).toBe(false);
    expect(state.replacementCount).toBe(1);
  });

  it('skill 挑战不阻塞同区间内的非 skill 条目之外的重试', () => {
    const view = observeView([
      { kind: 'assistant', lo: 8, hi: 8, text: 'skill', toolName: 'skill' },
    ]);
    const state = new CompressionState(view);
    expect(state.compressHistory({ start: 6, end: 8, content: 'x' }).isError).toBe(true);
    // 首次挑战后，不含 skill 的不相交区间不受影响
    expect(state.compressHistory({ index: 7, content: 'y' }).isError).toBe(false);
    expect(state.replacementCount).toBe(1);
  });
});

describe('executeCall 与 complete', () => {
  it('分发到对应工具，未知工具与非法 JSON 报错', () => {
    const state = new CompressionState(observeView());
    expect(state.executeCall('getHistory', '{}').isError).toBe(false);
    expect(state.executeCall('unknown', '{}').isError).toBe(true);
    expect(state.executeCall('getHistory', 'not json').isError).toBe(true);
    expect(state.executeCall('completeCompression', '').isError).toBe(false);
  });

  it('complete 标记完成，空提交允许', () => {
    const state = new CompressionState(observeView());
    expect(state.completed).toBe(false);
    const result = state.complete();
    expect(result.isError).toBe(false);
    expect(state.completed).toBe(true);
    expect(state.replacementCount).toBe(0);
  });

  it('complete 成功时 result 是最终 <history> 块，与 buildFinalBlock 一致', () => {
    const state = new CompressionState(observeView());
    state.getHistory({});
    state.markHistoryDelivered();
    expect(state.compressHistory({ index: 2, content: '摘要B' }).isError).toBe(false);
    const result = state.complete();
    expect(result.isError).toBe(false);
    expect(result.text).toBe(state.buildFinalBlock());
    expect(result.text).toContain(`<${HISTORY_TAG} tip=`);
    expect(result.text).toContain('<assistant index="2"><![CDATA[摘要B]]></assistant>');
    expect(result.text).not.toBe('压缩完成');
  });

  it('complete 被门禁拒绝时 result 不含 <history> 块', () => {
    const state = new CompressionState(viewOf([originalAsk(1)]));
    const result = state.complete();
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain(`<${HISTORY_TAG}`);
  });
});

describe('buildFinalBlock', () => {
  it('合并替换与原样条目：user 原样、替换生成摘要条目、未替换 assistant 保留、reasoning 不进产物', () => {
    const view = viewOf([
      { kind: 'user', lo: 0, hi: 0, text: '用户消息A' },
      { kind: 'reasoning', lo: 2, hi: 2, text: '思考' },
      { kind: 'assistant', lo: 2, hi: 2, text: '助手B' },
      { kind: 'assistant', lo: 3, hi: 3, text: '助手C' },
      { kind: 'assistant', lo: 4, hi: 4, text: '助手D' },
      { kind: 'user', lo: 5, hi: 5, text: '用户消息E' },
      { kind: 'assistant', lo: 6, hi: 7, text: '区间条目F-G' },
    ]);
    const state = new CompressionState(view);
    expect(state.compressHistory({ index: 2, content: 'B的摘要' }).isError).toBe(false);
    expect(state.compressHistory({ start: 3, end: 4, content: 'C和D的摘要' }).isError).toBe(false);
    const block = state.buildFinalBlock();
    expect(
      block.startsWith(
        `<${HISTORY_TAG} tip="${HISTORY_TIP}">\n${historyFormatNote({ user: true })}\n`,
      ),
    ).toBe(true);
    expect(block).toContain('<user_message index="0"><![CDATA[用户消息A]]></user_message>');
    expect(block).not.toContain('<sys');
    expect(block).toContain('<assistant index="2"><![CDATA[B的摘要]]></assistant>');
    expect(block).toContain('<assistant start="3" end="4"><![CDATA[C和D的摘要]]></assistant>');
    expect(block).toContain('<user_message index="5"><![CDATA[用户消息E]]></user_message>');
    // 未替换条目原样保留（含区间条目原属性）
    expect(block).toContain('<assistant start="6" end="7"><![CDATA[区间条目F-G]]></assistant>');
    // reasoning 不进产物，被替换条目原文不出现
    expect(block).not.toContain('<reasoning>');
    expect(block).not.toContain('助手B');
    expect(block).not.toContain('助手C');
    expect(block.endsWith(`\n</${HISTORY_TAG}>`)).toBe(true);
  });

  it('替换摘要以 CDATA 包裹嵌入，XML 特殊字符逐字保留，]]> 拆为相邻段', () => {
    const state = new CompressionState(observeView());
    expect(state.compressHistory({ index: 2, content: '<x>&"摘要"' }).isError).toBe(false);
    expect(state.compressHistory({ index: 3, content: 'a]]>b' }).isError).toBe(false);
    const block = state.buildFinalBlock();
    expect(block).toContain('<assistant index="2"><![CDATA[<x>&"摘要"]]></assistant>');
    expect(block).toContain(
      '<assistant index="3"><![CDATA[a]]><![CDATA[]]]]><![CDATA[>b]]></assistant>',
    );
  });

  it('content 含 CDATA 包裹报错，去除后重新提交成功', () => {
    const state = new CompressionState(observeView());
    const rejected = state.compressHistory({ index: 2, content: '<![CDATA[摘要]]>' });
    expect(rejected.isError).toBe(true);
    expect(rejected.text).toContain('CDATA');
    expect(state.replacementCount).toBe(0);
    expect(state.compressHistory({ index: 2, content: '摘要' }).isError).toBe(false);
  });

  it('空提交时全部条目原样保留', () => {
    const state = new CompressionState(observeView());
    const block = state.buildFinalBlock();
    expect(block).toContain('<assistant index="2"><![CDATA[助手B]]></assistant>');
    expect(block).toContain('<assistant index="7"><![CDATA[助手G]]></assistant>');
    expect(state.replacementCount).toBe(0);
  });

  it('不可定位遗留条目原样保留', () => {
    const view = viewOf([
      { kind: 'assistant', lo: 0, hi: 0, text: 'A' },
      { kind: 'assistant', text: '遗留块内容', blockSeq: 9 },
      { kind: 'assistant', lo: 1, hi: 1, text: 'B' },
    ]);
    const state = new CompressionState(view);
    const block = state.buildFinalBlock();
    expect(block).toContain('<assistant index="0"><![CDATA[A]]></assistant>');
    expect(block).toContain('<assistant><![CDATA[遗留块内容]]></assistant>');
    expect(block).toContain('<assistant index="1"><![CDATA[B]]></assistant>');
  });

  it('摘要位于被替换条目原位置，不提前到其前的遗留条目之前', () => {
    const view = viewOf([
      { kind: 'assistant', text: '遗留块内容', blockSeq: 9 },
      { kind: 'assistant', lo: 1, hi: 1, text: 'B', blockSeq: 10 },
      { kind: 'assistant', lo: 2, hi: 2, text: 'C', blockSeq: 10 },
    ]);
    const state = new CompressionState(view);
    expect(state.compressHistory({ start: 1, end: 2, content: '摘要BC' }).isError).toBe(false);
    const block = state.buildFinalBlock();
    expect(block.indexOf('遗留块内容')).toBeGreaterThan(-1);
    expect(block.indexOf('遗留块内容')).toBeLessThan(block.indexOf('摘要BC'));
  });

  it('skill 条目未压缩以 <skill_content name index> 呈现，压缩后变为常规 assistant 摘要条目', () => {
    const view = viewOf([
      { kind: 'user', lo: 0, hi: 0, text: '用户消息A' },
      {
        kind: 'assistant',
        lo: 1,
        hi: 1,
        text: '<skill_content name="lark-im"><skill_resources>资源内容</skill_resources><skill_instructions>指令内容</skill_instructions></skill_content>',
        toolName: 'skill',
        skillName: 'lark-im',
      },
      { kind: 'assistant', lo: 2, hi: 2, text: '助手B' },
    ]);
    const state = new CompressionState(view);
    const before = state.buildFinalBlock();
    expect(before).toContain(
      '<skill_content name="lark-im" index="1"><skill_resources><![CDATA[资源内容]]></skill_resources><skill_instructions><![CDATA[指令内容]]></skill_instructions></skill_content>',
    );
    // 未压缩的 skill 条目存在时，块顶注释含 skill 说明；user 条目存在时含 user 说明
    expect(
      before.startsWith(
        `<${HISTORY_TAG} tip="${HISTORY_TIP}">\n${historyFormatNote({ user: true, skill: true })}\n`,
      ),
    ).toBe(true);
    // 二次确认后才允许压缩：产物中 skill 条目变为常规 assistant 摘要条目
    expect(state.compressHistory({ index: 1, content: 'skill 摘要' }).isError).toBe(true);
    expect(state.compressHistory({ index: 1, content: 'skill 摘要' }).isError).toBe(false);
    const block = state.buildFinalBlock();
    expect(block).toContain('<assistant index="1"><![CDATA[skill 摘要]]></assistant>');
    expect(block).not.toContain('<skill_content name="lark-im"');
    expect(block).not.toContain('资源内容');
    // skill 条目被压缩后不再有未压缩 skill 条目，块顶注释随之不含 skill 说明
    expect(
      block.startsWith(
        `<${HISTORY_TAG} tip="${HISTORY_TIP}">\n${historyFormatNote({ user: true })}\n`,
      ),
    ).toBe(true);
  });

  it('toolcall 条目以结构化形态呈现，压缩后变为常规摘要条目', () => {
    const view = viewOf([
      { kind: 'user', lo: 0, hi: 0, text: '用户消息A' },
      {
        kind: 'assistant',
        lo: 1,
        hi: 1,
        text: '[tool-call run_code id=c1]\n{"code":"x"}\n\n[result]\n执行结果',
        toolName: 'run_code',
        toolArgs: '{"code":"x"}',
        toolResult: '执行结果',
      },
    ]);
    const state = new CompressionState(view);
    // getHistory 与最终块中 toolcall 条目均为结构化形态（与 recall 一致），不含 callId
    const structured =
      '<assistant index="1" type="toolcall" tool-name="run_code"><tool-args><![CDATA[{"code":"x"}]]></tool-args><tool-result><![CDATA[执行结果]]></tool-result></assistant>';
    expect(state.getHistory({}).text).toContain(structured);
    expect(state.buildFinalBlock()).toContain(structured);
    // 压缩该条目后变为常规摘要条目，结构化形态消失
    expect(state.compressHistory({ index: 1, content: '调用摘要' }).isError).toBe(false);
    const block = state.buildFinalBlock();
    expect(block).toContain('<assistant index="1"><![CDATA[调用摘要]]></assistant>');
    expect(block).not.toContain('<assistant index="1" type="toolcall"');
  });

  it('产物中的 skill 条目经反思视图解析后仍保留二次确认', () => {
    const view = viewOf([
      {
        kind: 'assistant',
        lo: 4,
        hi: 4,
        text: 'skill 返回内容',
        toolName: 'skill',
        skillName: 'lark-im',
        blockSeq: 9,
      },
    ]);
    const first = new CompressionState(view);
    const block = first.buildFinalBlock();
    expect(block).toContain(
      '<skill_content name="lark-im" index="4"><![CDATA[skill 返回内容]]></skill_content>',
    );
    // 反思轮解析产物块 → skill 条目仍可定位且带 toolName，首次压缩仍被挑战
    const parsed = buildReflectView([{ text: block, seq: 9 }]);
    const second = new CompressionState(parsed);
    expect(second.compressHistory({ index: 4, content: '压缩skill' }).isError).toBe(true);
    expect(second.compressHistory({ index: 4, content: '压缩skill' }).isError).toBe(false);
  });

  it('ask_user_question 条目未压缩以 <ask-user-question index> 呈现，二次确认后压缩为常规摘要条目', () => {
    const view = viewOf([
      { kind: 'user', lo: 0, hi: 0, text: '用户消息A' },
      {
        kind: 'assistant',
        lo: 1,
        hi: 1,
        text: '<ask-user-question>q:继续吗 a:用户回答</ask-user-question>',
        toolName: 'ask_user_question',
      },
    ]);
    const state = new CompressionState(view);
    // getHistory 与最终块中 ask_user_question 条目均为 <ask-user-question> 结构化形态（CDATA 内 q:/a: 成对行）
    const structured =
      '<ask-user-question index="1"><![CDATA[q:继续吗 a:用户回答]]></ask-user-question>';
    expect(state.getHistory({}).text).toContain(structured);
    expect(state.buildFinalBlock()).toContain(structured);
    // 二次确认后才允许压缩：首次覆盖报错且不执行，错误信息点名工具并要求重新思考
    const first = state.compressHistory({ index: 1, content: '提问摘要' });
    expect(first.isError).toBe(true);
    expect(first.text).toContain('ask_user_question');
    expect(first.text).toContain('重新思考');
    expect(state.replacementCount).toBe(0);
    expect(state.compressHistory({ index: 1, content: '提问摘要' }).isError).toBe(false);
    expect(state.replacementCount).toBe(1);
    const block = state.buildFinalBlock();
    expect(block).toContain('<assistant index="1"><![CDATA[提问摘要]]></assistant>');
    expect(block).not.toContain('<ask-user-question');
    expect(block).not.toContain('<askuserquestion');
  });

  it('旧格式 askuserquestion 条目在产物中原样保留，经反思视图解析后仍保留二次确认', () => {
    const view = viewOf([
      {
        kind: 'assistant',
        lo: 4,
        hi: 4,
        text: '<askuserquestion><questions>{"q":1}</questions><answers>回答</answers></askuserquestion>',
        toolName: 'ask_user_question',
        blockSeq: 9,
      },
    ]);
    const first = new CompressionState(view);
    const block = first.buildFinalBlock();
    expect(block).toContain(
      '<askuserquestion index="4"><questions><![CDATA[{"q":1}]]></questions><answers><![CDATA[回答]]></answers></askuserquestion>',
    );
    // 反思轮解析产物块 → 旧格式条目仍可定位且带 toolName，首次压缩仍被挑战
    const parsed = buildReflectView([{ text: block, seq: 9 }]);
    const second = new CompressionState(parsed);
    expect(second.compressHistory({ index: 4, content: '压缩提问' }).isError).toBe(true);
    expect(second.compressHistory({ index: 4, content: '压缩提问' }).isError).toBe(false);
  });

  it('块顶注释按最终条目动态生成：四类特殊条目齐备时说明完整，仅 assistant 条目时不含条目说明', () => {
    const full = viewOf([
      { kind: 'user', lo: 0, hi: 0, text: '用户消息A' },
      {
        kind: 'assistant',
        lo: 2,
        hi: 2,
        text: '<skill_content name="x"><skill_resources>资源</skill_resources><skill_instructions>指令</skill_instructions></skill_content>',
        toolName: 'skill',
        skillName: 'x',
      },
      {
        kind: 'assistant',
        lo: 3,
        hi: 3,
        text: '<ask-user-question>q:问题 a:回答</ask-user-question>',
        toolName: 'ask_user_question',
      },
    ]);
    const fullBlock = new CompressionState(full).buildFinalBlock();
    expect(
      fullBlock.startsWith(
        `<${HISTORY_TAG} tip="${HISTORY_TIP}">\n${historyFormatNote({ user: true, skill: true, askUserQuestion: true })}\n`,
      ),
    ).toBe(true);

    const plain = viewOf([{ kind: 'assistant', lo: 0, hi: 0, text: '助手A' }]);
    const plainBlock = new CompressionState(plain).buildFinalBlock();
    // 无 user / skill / ask_user_question 条目时，块顶注释仅含通用说明
    expect(
      plainBlock.startsWith(`<${HISTORY_TAG} tip="${HISTORY_TIP}">\n${historyFormatNote({})}\n`),
    ).toBe(true);
    expect(plainBlock).not.toContain('表示用户消息原文');
    expect(plainBlock).not.toContain('表示未压缩的原始 skill');
    expect(plainBlock).not.toContain('表示向用户提问');
    // 完整消息定义始终位于块顶注释
    expect(fullBlock).toContain(COMPLETE_MESSAGE_DEFINITION);
    expect(plainBlock).toContain(COMPLETE_MESSAGE_DEFINITION);
  });
});

describe('归档模式', () => {
  const block = [
    '<history>',
    '<user_message index="0"><![CDATA[需求]]></user_message>',
    '<assistant start="1" end="2"><![CDATA[排查 src/a.ts]]></assistant>',
    '<assistant index="3"><![CDATA[修复]]></assistant>',
    '<user_message index="4"><![CDATA[继续]]></user_message>',
    '<assistant index="5"><![CDATA[验证]]></assistant>',
    '</history>',
  ].join('\n');
  const archive = (): CompressionState =>
    new CompressionState(buildArchiveView([{ text: block, seq: 1 }]).view);
  const call = (state: CompressionState, args: object) =>
    state.executeCall('compressHistory', JSON.stringify(args));

  it('区间必须恰为一个归档段', () => {
    const state = archive();
    const partial = call(state, { start: 1, end: 2, content: '一句话', keywords: ['a'] });
    expect(partial.isError).toBe(true);
    expect(partial.text).toContain('[1..3]、[5..5]');
    expect(call(state, { start: 1, end: 3, content: '一句话', keywords: ['a'] }).isError).toBe(
      false,
    );
  });

  it('content 须单行，keywords 必填', () => {
    const state = archive();
    const base = { start: 1, end: 3 };
    expect(call(state, { ...base, content: '两行\n内容', keywords: ['a'] }).isError).toBe(true);
    expect(call(state, { ...base, content: '一句话' }).isError).toBe(true);
    expect(call(state, { ...base, content: '一句话', keywords: [' '] }).isError).toBe(true);
  });

  it('content 300 字符只是建议值，硬上限 1000 字符', () => {
    const base = { start: 1, end: 3, keywords: ['a'] };
    // 超过建议值、未到硬上限的摘要直接生效
    expect(
      call(archive(), { ...base, content: 'x'.repeat(ARCHIVE_SUMMARY_SOFT_CHARS + 1) }).isError,
    ).toBe(false);
    expect(
      call(archive(), { ...base, content: 'x'.repeat(ARCHIVE_SUMMARY_MAX_CHARS) }).isError,
    ).toBe(false);
    const over = call(archive(), {
      ...base,
      content: 'x'.repeat(ARCHIVE_SUMMARY_MAX_CHARS + 1),
    });
    expect(over.isError).toBe(true);
    expect(over.text).toContain(`${ARCHIVE_SUMMARY_MAX_CHARS} 字符上限`);
  });

  it('全部段覆盖前拒绝完成，完成后产出带 key-word 的 archived-history 块', () => {
    const state = archive();
    call(state, {
      start: 1,
      end: 3,
      content: '修复 src/a.ts 的空指针',
      keywords: ['src/a.ts', '空指针'],
    });
    const blocked = state.executeCall('completeCompression', '{}');
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toContain('[5..5]');
    call(state, { start: 5, end: 5, content: '验证通过', keywords: ['验证'] });
    const done = state.executeCall('completeCompression', '{}');
    expect(done.isError).toBe(false);
    expect(done.text.startsWith(`<${ARCHIVED_HISTORY_TAG} tip=`)).toBe(true);
    expect(done.text).toContain(
      '<assistant start="1" end="3" key-word="src/a.ts, 空指针"><![CDATA[修复 src/a.ts 的空指针]]></assistant>',
    );
    expect(done.text).toContain('<user_message index="4"><![CDATA[继续]]></user_message>');
  });

  it('非归档视图不受段约束', () => {
    const state = new CompressionState(buildReflectView([{ text: block, seq: 1 }]));
    expect(call(state, { start: 1, end: 2, content: '多行\n摘要' }).isError).toBe(false);
  });
});
