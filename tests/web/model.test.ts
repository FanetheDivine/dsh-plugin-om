// om 成本计算器模型回归测试：无 om 基线、观察/反思触发、注入遮蔽、缓存失效与表格生成。
// 模型口径见 web/src/model.ts 文件头（页面成本表上方「表格假设」同步展示）。
// 会话为纯多 step 工具循环：thinking 只计补全、不占上下文，默认不进 OM
//（开启「压缩 thinking」时观察压缩随被压缩消息一并输入 OM）；
// tool result 只写入驱动轮数。
import { describe, expect, it } from 'vitest';
import {
  buildTable,
  computeRow,
  DEFAULT_PARAMS,
  INSTRUCTION_TOKENS,
  type ModelParams,
  SYS_RESIDUAL_TOKENS,
  simulateWithOm,
  simulateWithoutOm,
  TABLE_MAX_TOKENS,
  TABLE_MIN_TOKENS,
  turnCount,
} from '../../web/src/model.ts';

/** 默认参数（冻结对象，测试内以展开方式做局部覆盖）。 */
const P = DEFAULT_PARAMS;

/** 局部覆盖默认参数的便捷构造。 */
function withParams(override: Partial<Omit<ModelParams, 'prices'>>): ModelParams {
  return { ...DEFAULT_PARAMS, ...override };
}

describe('turnCount', () => {
  it('原始会话规模 = 前缀 + n·toolResult：默认参数 20k → 7 轮', () => {
    // (20000 - 10000 - 5000) / 800 = 6.25 → 7
    expect(turnCount(P, 20_000)).toBe(7);
  });

  it('250k → 294 轮', () => {
    expect(turnCount(P, 250_000)).toBe(294);
  });

  it('规模不足以容纳前缀时为 0 轮；非整除向上取整', () => {
    expect(turnCount(P, 15_000)).toBe(0);
    expect(turnCount(P, 16_000)).toBe(2); // (16000-15000)/800=1.25 → 2
    expect(turnCount(P, 17_000)).toBe(3); // (17000-15000)/800=2.5 → 3
  });

  it('thinking 只输出不影响轮数：置 0 轮数不变', () => {
    expect(turnCount(withParams({ thinkingTokens: 0 }), 250_000)).toBe(294);
  });

  it('toolResult ≤ 0 视为会话不增长：任意规模均为 0 轮', () => {
    expect(turnCount(withParams({ toolResultTokens: 0 }), 250_000)).toBe(0);
    expect(turnCount(withParams({ toolResultTokens: -100 }), 250_000)).toBe(0);
  });
});

describe('simulateWithoutOm', () => {
  it('基线三类 token 按闭式公式累计', () => {
    // n=7、thinking=1200、toolResult=800、prefix=15000：
    // prompt_t = 15000 + (t-1)·800
    // cacheWrite = 15000 + 6×800 = 19800
    // cacheRead = 6×15000 + 800×(0+…+5) = 90000 + 12000 = 102000
    // completion = 7×1200 = 8400
    const r = simulateWithoutOm(P, 20_000);
    expect(r.turns).toBe(7);
    expect(r.cacheWrite).toBe(19_800);
    expect(r.cacheRead).toBe(102_000);
    expect(r.completion).toBe(8_400);
    expect(r.observeCount).toBe(0);
    expect(r.reflectCount).toBe(0);
    expect(r.peakPromptTokens).toBe(10_000 + 5_000 + 6 * 800);
  });

  it('费用 = 三类 token 分别计价求和', () => {
    const r = simulateWithoutOm(P, 20_000);
    const expected = (r.completion * 25 + r.cacheRead * 0.5 + r.cacheWrite * 6.25) / 1_000_000;
    expect(r.cost).toBeCloseTo(expected, 10);
  });

  it('规模不足前缀（0 轮）时全为零', () => {
    const r = simulateWithoutOm(P, 9_000);
    expect(r.turns).toBe(0);
    expect(r.cacheWrite).toBe(0);
    expect(r.cacheRead).toBe(0);
    expect(r.completion).toBe(0);
    expect(r.cost).toBe(0);
  });
});

describe('simulateWithOm（默认阈值）', () => {
  it('首次观察在净压力 = 注入 + 未压缩量达到阈值时触发：第 51 轮（40000 + 5000 ≥ 45000）', () => {
    const r = simulateWithOm(P, 60_000);
    // n = (60000-15000)/800 = 56.25 → 57 轮；W 在第 51 轮 pre-step 时为 50×800 = 40000
    expect(r.observeCount).toBe(1);
    // 被压缩消息 = 未压缩 tool result 40000（默认不压缩 thinking）
    // 摘要 input = 指令 + 40000（注入内容不进摘要输入）；压缩过程消耗 = 50% × 40000 = 20000
    expect(r.summaryInputTokens).toBe(INSTRUCTION_TOKENS + 40_000);
    expect(r.summaryOutputTokens).toBe(0.5 * 40_000);
    // 默认参数下 60k 规模不会触发反思
    expect(r.reflectCount).toBe(0);
  });

  it('250k 规模：观察约每 57 轮一次、反思不触发、峰值远低于原始规模', () => {
    const r = simulateWithOm(P, 250_000);
    expect(r.turns).toBe(294);
    // 观察 5 次：首次第 51 轮 W=40000（含注入 5000），其后每累计 45600+50 再触发
    // （第 108/165/222/279 轮）
    expect(r.observeCount).toBe(5);
    expect(r.reflectCount).toBe(0); // H = 1200 + 4×1368 = 6672 < 120000
    // 峰值出现在第 5 次观察前一轮（第 278 轮）：10000 + 50 + 5304 + 56×800 = 60154
    expect(r.peakPromptTokens).toBe(10_000 + 50 + 5_304 + 56 * 800);
    // 摘要 input = (指令 + 40000) + 4×(指令 + 45600)
    expect(r.summaryInputTokens).toBe(
      INSTRUCTION_TOKENS + 40_000 + 4 * (INSTRUCTION_TOKENS + 45_600),
    );
    expect(r.summaryOutputTokens).toBe(0.5 * (40_000 + 4 * 45_600));
  });

  it('开启压缩 thinking 时观察阶段 thinking 随被压缩消息一并输入 OM，但不直接占主会话上下文', () => {
    const withThinking = simulateWithOm(withParams({ compressThinking: true }), 60_000);
    const noThinking = simulateWithOm(P, 60_000);
    expect(withThinking.observeCount).toBe(noThinking.observeCount);
    // 第 51 轮观察时被压缩消息 = 50×800 tool result（开启压缩 thinking 时含 50×1200 thinking）
    expect(noThinking.summaryInputTokens).toBe(INSTRUCTION_TOKENS + 50 * 800);
    expect(withThinking.summaryInputTokens).toBe(INSTRUCTION_TOKENS + 50 * 800 + 50 * 1200);
    // 缓存创建差值 = 摘要 input 中多出的 thinking + 观察轮重建时块增量（压缩比 × thinking）
    expect(withThinking.cacheWrite - noThinking.cacheWrite).toBe(50 * 1_200 + 0.03 * 50 * 1_200);
    // thinking 不直接占主会话上下文：峰值出现在观察前一轮，两者一致
    expect(withThinking.peakPromptTokens).toBe(noThinking.peakPromptTokens);
    // history 块 = 压缩比 × 被压缩消息（含 thinking）：块大 1800，观察后 6 轮缓存读取随之增加
    expect(withThinking.cacheRead - noThinking.cacheRead).toBe(6 * 0.03 * 50 * 1_200);
  });

  it('压缩过程消耗按 OM token消耗比 × 被压缩消息计入 completion，不入缓存桶', () => {
    const r = simulateWithOm(P, 60_000);
    // n=57：主请求 thinking 57×1200 = 68400；压缩过程消耗 = 50% × 40000 = 20000
    expect(r.summaryOutputTokens).toBe(20_000);
    expect(r.completion).toBe(57 * 1_200 + 20_000);
    // 缓存创建只含摘要 input（1000+40000），不含压缩过程消耗
    expect(r.cacheWrite).toBe(15_000 + 49 * 800 + 1_250 + 6 * 800 + INSTRUCTION_TOKENS + 40_000);
  });

  it('默认参数下 250k：om 开仍更省，输出桶增量全部来自压缩过程消耗', () => {
    const row = computeRow(P, 250_000);
    expect(row.savings).toBeGreaterThan(0);
    // om 开的输出桶增量全部来自压缩过程消耗
    expect(row.on.completion - row.off.completion).toBe(row.on.summaryOutputTokens);
  });

  it('压缩比只决定 history 块大小、不参与计费：改压缩比输出桶不变、缓存桶变', () => {
    const small = simulateWithOm(withParams({ compressionRatio: 0.03 }), 250_000);
    const large = simulateWithOm(withParams({ compressionRatio: 0.1 }), 250_000);
    // 默认阈值下不触发反思（0.1 时 H = 4000 + 4×4560 = 22240 < 120000），被压缩消息合计与压缩比无关
    expect(small.reflectCount).toBe(0);
    expect(large.reflectCount).toBe(0);
    expect(large.completion).toBe(small.completion);
    expect(large.summaryOutputTokens).toBe(small.summaryOutputTokens);
    // 块更大 → 上下文更大 → 缓存读写与峰值更高
    expect(large.peakPromptTokens).toBeGreaterThan(small.peakPromptTokens);
    expect(large.cacheRead).toBeGreaterThan(small.cacheRead);
  });

  it('OM token消耗比只影响输出桶：改比例缓存桶与观察/反思次数不变', () => {
    const zero = simulateWithOm(withParams({ omTokenRatio: 0 }), 250_000);
    const high = simulateWithOm(withParams({ omTokenRatio: 2 }), 250_000);
    expect(high.cacheRead).toBe(zero.cacheRead);
    expect(high.cacheWrite).toBe(zero.cacheWrite);
    expect(high.observeCount).toBe(zero.observeCount);
    expect(high.reflectCount).toBe(zero.reflectCount);
    expect(zero.summaryOutputTokens).toBe(0);
    expect(high.completion - zero.completion).toBe(high.summaryOutputTokens);
  });

  it('观察轮主请求缓存从替换点重新创建：该轮只缓存读取系统提示词', () => {
    // T=60k（n=57）：第 51 轮 pre-step 观察（替换点在 history 首部，保留前缀 = 系统提示词）
    // cacheRead = 前 50 轮 prompt 累计(1675800) + 第 51 轮截断读取(10000) + 第 52–57 轮(79500)
    // cacheWrite = 首轮 15000 + 常规增量 49×800 + 第 51 轮重写 1250 + 6×800 + 摘要 input(1000+40000)
    const r = simulateWithOm(P, 60_000);
    expect(r.cacheRead).toBe(1_675_800 + 10_000 + 79_500);
    expect(r.cacheWrite).toBe(15_000 + 49 * 800 + 1_250 + 6 * 800 + INSTRUCTION_TOKENS + 40_000);
    // om-off 对照：无截断，每轮读取完整上一轮 prompt
    const off = simulateWithoutOm(P, 60_000);
    expect(off.cacheRead).toBeGreaterThan(r.cacheRead);
    expect(off.cacheWrite).toBe(15_000 + 56 * 800);
  });
});

describe('simulateWithOm（注入遮蔽与反思）', () => {
  it('首次观察后注入消息遮蔽为 <sys> 空条目残留：峰值出现在观察前一轮请求', () => {
    const r = simulateWithOm(P, 60_000);
    // n=57；第 51 轮 pre-step 触发观察（该轮请求已压缩后发出），
    // 峰值 = 第 50 轮请求：10000 + 5000 + 49×800 = 54200
    expect(r.peakPromptTokens).toBe(10_000 + 5_000 + 49 * 800);
    // 观察后注入不再占上下文：残留 ≤ SYS_RESIDUAL_TOKENS 体现在后续 prompt 中
    expect(SYS_RESIDUAL_TOKENS).toBeLessThan(P.injectedTokens);
  });

  it('调小反思阈值时触发合并：反思摘要 input = 指令 + 当时 H 合计', () => {
    const params = withParams({ reflectThresholdTokens: 2_000, observeThresholdTokens: 45_000 });
    const r = simulateWithOm(params, 120_000);
    // n=132：观察 2 次（第 51/108 轮，被压缩消息 40000 / 45600）；
    // 反思 1 次：第 109 轮（H=1200+1368=2568 ≥ 2000 → H=77.04）
    expect(r.observeCount).toBe(2);
    expect(r.reflectCount).toBe(1);
    // 摘要 input = (1000+40000) + (1000+45600) + 反思(1000+2568)
    expect(r.summaryInputTokens).toBeCloseTo(
      INSTRUCTION_TOKENS + 40_000 + (INSTRUCTION_TOKENS + 45_600) + (INSTRUCTION_TOKENS + 2_568),
      5,
    );
    // 三次摘要调用的压缩过程消耗合计 = 50% × 被压缩消息合计（40000 + 45600 + 2568）
    expect(r.summaryOutputTokens).toBeCloseTo(0.5 * (40_000 + 45_600 + 2_568), 5);
  });

  it('反思在观察产生块之后的 pre-step 触发（每轮 pre-step 先反思后观察）', () => {
    const params = withParams({ reflectThresholdTokens: 100, observeThresholdTokens: 45_000 });
    const r = simulateWithOm(params, 120_000);
    // 观察 2 次（第 51/108 轮）；反思 2 次：第 52 轮（H=1200）、第 109 轮（H=36+1368=1404）
    expect(r.observeCount).toBe(2);
    expect(r.reflectCount).toBe(2);
  });

  it('观察阈值超过会话规模时不压缩：与 om 关闭同构', () => {
    const params = withParams({ observeThresholdTokens: 1_000_000 });
    const on = simulateWithOm(params, 20_000);
    const off = simulateWithoutOm(params, 20_000);
    expect(on.observeCount).toBe(0);
    expect(on.cacheRead).toBe(off.cacheRead);
    expect(on.cacheWrite).toBe(off.cacheWrite);
    expect(on.cost).toBeCloseTo(off.cost, 10);
  });
});

describe('buildTable', () => {
  it('默认步长 10k：从 20k 到 250k 共 24 行、首末行正确', () => {
    const rows = buildTable(P);
    expect(rows.length).toBe(24);
    expect(rows[0]?.targetTokens).toBe(TABLE_MIN_TOKENS);
    expect(rows[rows.length - 1]?.targetTokens).toBe(TABLE_MAX_TOKENS);
    // 行间步长为 10000
    expect(rows[1]?.targetTokens).toBe(30_000);
    expect(rows[22]?.targetTokens).toBe(240_000);
  });

  it('自定义步长 25k：首行仍为 20k，末行并入 250k', () => {
    const rows = buildTable(withParams({ tableStepTokens: 25_000 }));
    expect(rows[0]?.targetTokens).toBe(20_000);
    expect(rows[1]?.targetTokens).toBe(45_000);
    expect(rows[rows.length - 1]?.targetTokens).toBe(TABLE_MAX_TOKENS);
  });

  it('步长低于 1000 时按 1000 下限执行（行数防护），为 0 也不死循环', () => {
    // 20000..249000 共 230 行 + 末行并入 250000
    const rows = buildTable(withParams({ tableStepTokens: 500 }));
    expect(rows.length).toBe(231);
    expect(rows[1]?.targetTokens).toBe(21_000);
    const zero = buildTable(withParams({ tableStepTokens: 0 }));
    expect(zero.length).toBe(231);
  });

  it('每行 savings = off.cost − on.cost', () => {
    for (const row of buildTable(P)) {
      expect(row.savings).toBeCloseTo(row.off.cost - row.on.cost, 10);
    }
  });
});
