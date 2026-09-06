// 压缩工具状态机单测：getHistory / compressHistory / completeCompression 的校验与执行、
// skill 二次确认、替换区间重叠规则与最终 <history> 块构建。
import { describe, expect, it } from 'vitest';
import { CompressionState } from '../src/compress-tools.ts';
import type { CompressionView, ViewEntry } from '../src/compress-view.ts';
import { HISTORY_FORMAT_NOTE, HISTORY_TAG, HISTORY_TIP } from '../src/constants.ts';

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

/** 观察风格视图：0 用户 / 1 系统 / 2-4 assistant / 5 用户 / 6-7 assistant。 */
function observeView(overrides: ViewEntry[] = []): CompressionView {
  const base: ViewEntry[] = [
    { kind: 'user', lo: 0, hi: 0, text: '用户消息A' },
    { kind: 'sys', lo: 1, hi: 1, text: '', sysKind: 'system' },
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

describe('getHistory', () => {
  it('start/end 缺省返回要求区间全部条目，带区间注释头，无 history 包裹', () => {
    const state = new CompressionState(observeView());
    const result = state.getHistory({});
    expect(result.isError).toBe(false);
    expect(result.text).toContain('<!-- 完整消息区间 [0..7]，共 8 条 -->');
    expect(result.text).toContain('<user_message index="0">用户消息A</user_message>');
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

  it('覆盖用户消息或系统消息报错', () => {
    const state = new CompressionState(observeView());
    const userHit = state.compressHistory({ start: 0, end: 2, content: 'x' });
    expect(userHit.isError).toBe(true);
    expect(userHit.text).toContain('用户消息');
    const sysHit = state.compressHistory({ index: 1, content: 'x' });
    expect(sysHit.isError).toBe(true);
    expect(sysHit.text).toContain('系统消息');
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

  it('与已有替换区间部分重叠报错（1-3 后 2-4），完全包含不报错（1-3 后 1-4）', () => {
    const state = new CompressionState(observeView());
    expect(state.compressHistory({ start: 2, end: 4, content: 'A' }).isError).toBe(false);
    // 2-4 已压缩，2-5 部分重叠（2-4 未被完全包含）→ 报错
    expect(state.compressHistory({ start: 3, end: 5, content: 'B' }).isError).toBe(true);
    // 1-4 完全包含 2-4 → 不报错并覆盖
    expect(state.compressHistory({ start: 2, end: 4, content: 'C' }).isError).toBe(false);
    expect(state.replacementCount).toBe(1);
    // 相同区间重复提交 → 完全覆盖自身，允许
    expect(state.compressHistory({ start: 2, end: 4, content: 'D' }).isError).toBe(false);
    expect(state.replacementCount).toBe(1);
    // 不相交区间正常追加
    expect(state.compressHistory({ start: 6, end: 7, content: 'E' }).isError).toBe(false);
    expect(state.replacementCount).toBe(2);
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
});

describe('buildFinalBlock', () => {
  it('合并替换与原样条目：user/sys 原样、替换生成摘要条目、未替换 assistant 保留、reasoning 不进产物', () => {
    const view = viewOf([
      { kind: 'user', lo: 0, hi: 0, text: '用户消息A' },
      { kind: 'sys', lo: 1, hi: 1, text: '', sysKind: 'system' },
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
      block.startsWith(`<${HISTORY_TAG} tip="${HISTORY_TIP}">\n${HISTORY_FORMAT_NOTE}\n`),
    ).toBe(true);
    expect(block).toContain('<user_message index="0">用户消息A</user_message>');
    expect(block).toContain('<sys type="system" index="1"></sys>');
    expect(block).toContain('<assistant index="2">B的摘要</assistant>');
    expect(block).toContain('<assistant start="3" end="4">C和D的摘要</assistant>');
    expect(block).toContain('<user_message index="5">用户消息E</user_message>');
    // 未替换条目原样保留（含区间条目原属性）
    expect(block).toContain('<assistant start="6" end="7">区间条目F-G</assistant>');
    // reasoning 不进产物，被替换条目原文不出现
    expect(block).not.toContain('<reasoning>');
    expect(block).not.toContain('助手B');
    expect(block).not.toContain('助手C');
    expect(block.endsWith(`\n</${HISTORY_TAG}>`)).toBe(true);
  });

  it('替换 content 中的 XML 特殊字符被转义', () => {
    const state = new CompressionState(observeView());
    expect(state.compressHistory({ index: 2, content: '<x>&"摘要"' }).isError).toBe(false);
    expect(state.buildFinalBlock()).toContain(
      '<assistant index="2">&lt;x&gt;&amp;"摘要"</assistant>',
    );
  });

  it('空提交时全部条目原样保留', () => {
    const state = new CompressionState(observeView());
    const block = state.buildFinalBlock();
    expect(block).toContain('<assistant index="2">助手B</assistant>');
    expect(block).toContain('<assistant index="7">助手G</assistant>');
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
    expect(block).toContain('<assistant index="0">A</assistant>');
    expect(block).toContain('<assistant>遗留块内容</assistant>');
    expect(block).toContain('<assistant index="1">B</assistant>');
  });
});
