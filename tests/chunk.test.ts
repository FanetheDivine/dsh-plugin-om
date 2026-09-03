// 观察分块单元测试：chunkCompleteMessages（token 边界切块 / 完整消息不跨块）、
// mergeChunkReports（剥离外壳合并为单个 <history> 块——tip 与格式说明注释在合并时
// 最终装配一次；可再经 extractSummaryLog 校验）
// 与 runWithConcurrency（有界并发池：并发上限 / 结果按 index 对齐）。
import { describe, expect, it } from 'vitest';

import { chunkCompleteMessages, mergeChunkReports, runWithConcurrency } from '../src/compress.ts';
import { HISTORY_TAG, HISTORY_TIP } from '../src/constants.ts';
import { indexCompleteMessages } from '../src/log-index.ts';
import { extractSummaryLog, HISTORY_FORMAT_NOTE } from '../src/summarize.ts';
import type { SessionEvent } from '../src/types.ts';
import { makeMessage, makeSession, textBlock } from './helpers.ts';

/** 构造一个会话：给定文本序列 → 每条一个 user/message 事件。 */
function userSession(texts: string[]) {
  return makeSession({
    events: texts.map(
      (text) =>
        ({
          type: 'user/message' as const,
          data: makeMessage({ role: 'user', content: [textBlock(text)] }),
        }) as unknown as SessionEvent,
    ),
  });
}

/** 固定估算器：每条完整消息按给定 token 数计（忽略实际内容）。 */
function fixedTokens(tokens: number) {
  return () => tokens;
}

describe('chunkCompleteMessages（观察分块）', () => {
  it('空输入返回空数组', () => {
    const session = userSession([]);
    expect(chunkCompleteMessages(session, [], 30000, fixedTokens(10))).toEqual([]);
  });

  it('未超界时全部消息为一块', () => {
    const session = userSession(['m0', 'm1', 'm2']);
    const cms = indexCompleteMessages(session);
    const chunks = chunkCompleteMessages(session, cms, 100, fixedTokens(10));
    expect(chunks).toHaveLength(1);
    const first = chunks[0];
    expect(first?.map((cm) => cm.index)).toEqual([0, 1, 2]);
  });

  it('按 token 边界切块：30 tokens 边界下 4×10 tokens 切成 3+1', () => {
    const session = userSession(['m0', 'm1', 'm2', 'm3']);
    const cms = indexCompleteMessages(session);
    const chunks = chunkCompleteMessages(session, cms, 30, fixedTokens(10));
    expect(chunks.map((c) => c.map((cm) => cm.index))).toEqual([[0, 1, 2], [3]]);
  });

  it('累计恰好等于边界时不切块（> 边界才切）', () => {
    const session = userSession(['m0', 'm1', 'm2', 'm3']);
    const cms = indexCompleteMessages(session);
    const chunks = chunkCompleteMessages(session, cms, 40, fixedTokens(10));
    expect(chunks.map((c) => c.map((cm) => cm.index))).toEqual([[0, 1, 2, 3]]);
  });

  it('完整消息不跨块：单条超界的消息独立成块', () => {
    const session = userSession(['m0', 'm1', 'm2']);
    const cms = indexCompleteMessages(session);
    // 第一条 50 tokens（超界），后两条各 10 tokens
    const chunks = chunkCompleteMessages(session, cms, 30, (message: unknown) => {
      const text = String(
        (message as { content?: Array<{ text?: unknown }> }).content?.[0]?.text ?? '',
      );
      return text.includes('m0') ? 50 : 10;
    });
    expect(chunks.map((c) => c.map((cm) => cm.index))).toEqual([[0], [1, 2]]);
  });

  it('分块保持完整消息的相对顺序与覆盖（全部消息、无遗漏）', () => {
    const session = userSession(['m0', 'm1', 'm2', 'm3', 'm4']);
    const cms = indexCompleteMessages(session);
    const chunks = chunkCompleteMessages(session, cms, 25, fixedTokens(10));
    const flat = chunks.flat().map((cm) => cm.index);
    expect(flat).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('mergeChunkReports（分块摘要合并）', () => {
  it('剥离各块 <history> 外壳拼接为单个带 tip 的 <history> 块（块内容原样保留）', () => {
    const p0 = [
      '<history>',
      '<user_message index="0">',
      '消息A（足够长的内容占位）',
      '</user_message>',
      '</history>',
    ].join('\n');
    const p1 = [
      '<history>',
      '<user_message index="1">',
      '消息B（足够长的内容占位）',
      '</user_message>',
      '</history>',
    ].join('\n');
    const merged = mergeChunkReports([p0, p1]);
    expect(merged.startsWith('<history tip="')).toBe(true);
    expect(merged.endsWith('</history>')).toBe(true);
    expect(merged).toContain('<user_message index="0">');
    expect(merged).toContain('<user_message index="1">');
    expect(merged.match(/<history/g)).toHaveLength(1); // 只有合并后的一个开标签
  });

  it('合并结果结构合法：去掉 tip 属性后可再经 extractSummaryLog 解析（index 连续）', () => {
    const p0 = [
      '<history>',
      '<user_message index="0">',
      '较早块：第一段内容占位文本',
      '</user_message>',
      '</history>',
    ].join('\n');
    const p1 = [
      '<history>',
      '<user_message index="1">',
      '最后块：第二段内容占位文本',
      '</user_message>',
      '</history>',
    ].join('\n');
    const merged = mergeChunkReports([p0, p1]);
    const plain = merged.replace(/^<history[^>]*>/, '<history>');
    expect(extractSummaryLog(plain)).not.toBeNull();
  });

  it('块内容原样保留（含格式说明注释）', () => {
    const p0 = [
      '<history>',
      '<!-- 块内注释 -->',
      '<user_message index="0">',
      '注释保留内容占位',
      '</user_message>',
      '</history>',
    ].join('\n');
    const merged = mergeChunkReports([p0]);
    expect(merged).toContain('<!-- 块内注释 -->');
  });

  it('无外壳的块原样保留', () => {
    const merged = mergeChunkReports(['<user_message index="0">', '内容占位', '</user_message>']);
    expect(merged).toContain('<user_message index="0">');
  });

  it('最终装配：合并块带 tip 属性与格式说明注释各一条（chunk 中间产物不带）', () => {
    const p0 = [
      '<history>',
      '<user_message index="0">',
      '未装饰块内容占位甲',
      '</user_message>',
      '</history>',
    ].join('\n');
    const p1 = [
      '<history>',
      '<user_message index="1">',
      '未装饰块内容占位乙',
      '</user_message>',
      '</history>',
    ].join('\n');
    const merged = mergeChunkReports([p0, p1]);
    expect(merged.startsWith(`<${HISTORY_TAG} tip="${HISTORY_TIP}">`)).toBe(true);
    // tip 仅出现在合并开标签上（各块外壳已剥离）
    expect(merged.match(new RegExp(`<${HISTORY_TAG} tip=`, 'g'))).toHaveLength(1);
    // 格式说明注释仅一条（合并块顶，紧随开标签）
    expect(merged.split(HISTORY_FORMAT_NOTE)).toHaveLength(2);
    expect(merged.indexOf(HISTORY_FORMAT_NOTE)).toBe(
      `<${HISTORY_TAG} tip="${HISTORY_TIP}">`.length + 1,
    );
  });

  it('传入已装饰块（带 tip 与注释）也去重：合并块顶仅保留一条注释', () => {
    const decorated = [
      `<${HISTORY_TAG} tip="${HISTORY_TIP}">`,
      HISTORY_FORMAT_NOTE,
      '<user_message index="0">',
      '已装饰块内容占位',
      '</user_message>',
      `</${HISTORY_TAG}>`,
    ].join('\n');
    const merged = mergeChunkReports([decorated]);
    expect(merged.split(HISTORY_FORMAT_NOTE)).toHaveLength(2); // 原有的一条剥离，合并块顶补一条
    expect(merged).toContain('已装饰块内容占位');
  });

  it('块间不引入多余空行（内层首尾空白清除，拼接单换行）', () => {
    const p0 = [
      '<history>',
      '',
      '<user_message index="0">',
      '空行清除内容占位甲',
      '</user_message>',
      '',
      '</history>',
    ].join('\n');
    const p1 = [
      '<history>',
      '<user_message index="1">',
      '空行清除内容占位乙',
      '</user_message>',
      '',
      '',
      '</history>',
    ].join('\n');
    const merged = mergeChunkReports([p0, p1]);
    expect(merged).toContain('</user_message>\n<user_message index="1">'); // 块间单换行
    expect(merged).not.toMatch(/\n{3,}/); // 无连续多行空行
  });
});

describe('runWithConcurrency（有界并发池）', () => {
  /** 并发追踪器：记录当前活跃任务数与峰值。 */
  function makeTracker() {
    /** 当前活跃任务数。 */
    let active = 0;
    /** 活跃峰值（即观察到的最大并行数）。 */
    let peak = 0;
    return {
      /** 任务进入（活跃 +1，更新峰值）。 */
      enter() {
        active += 1;
        peak = Math.max(peak, active);
      },
      /** 任务退出（活跃 -1）。 */
      exit() {
        active -= 1;
      },
      /** 观察到的活跃峰值。 */
      get peak(): number {
        return peak;
      },
    };
  }

  it('结果按 index 对齐（完成顺序不影响结果顺序）', async () => {
    // 各任务等待时长与其下标相反：先发起的后完成
    const results = await runWithConcurrency([4, 3, 2, 1], 4, async (ms, index) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return index;
    });
    expect(results).toEqual([0, 1, 2, 3]);
  });

  it('并发数不超过 limit（峰值 = limit）', async () => {
    const tracker = makeTracker();
    await runWithConcurrency([10, 20, 30, 40, 50, 60], 2, async (ms) => {
      tracker.enter();
      await new Promise((resolve) => setTimeout(resolve, ms));
      tracker.exit();
      return ms;
    });
    expect(tracker.peak).toBe(2);
  });

  it('limit 大于任务数时全部并行（峰值 = 任务数）', async () => {
    const tracker = makeTracker();
    await runWithConcurrency([10, 20, 30], 8, async (ms) => {
      tracker.enter();
      await new Promise((resolve) => setTimeout(resolve, ms));
      tracker.exit();
      return ms;
    });
    expect(tracker.peak).toBe(3);
  });

  it('limit 为 0 或负数时按串行处理（峰值 = 1）', async () => {
    const tracker = makeTracker();
    await runWithConcurrency([1, 2, 3, 4], 0, async (n) => {
      tracker.enter();
      await new Promise((resolve) => setTimeout(resolve, n));
      tracker.exit();
      return n;
    });
    expect(tracker.peak).toBe(1);
  });

  it('空输入返回空数组', async () => {
    const results = await runWithConcurrency([], 2, async (n: number) => n);
    expect(results).toEqual([]);
  });

  it('任务返回 null 保留在结果中（失败由任务自身以返回值表达）', async () => {
    const results = await runWithConcurrency([1, 2, 3], 2, async (n) => (n === 2 ? null : n));
    expect(results).toEqual([1, null, 3]);
  });
});
