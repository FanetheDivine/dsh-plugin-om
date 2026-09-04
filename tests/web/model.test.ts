// om 成本计算器模型回归测试：无 om 基线、观察/反思触发、注入遮蔽、缓存失效与表格生成。
// 模型口径见 web/src/model.ts 文件头（页面「模型假设」一节同步展示）。
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
  it('原始会话规模 = 前缀 + n·Δ：默认参数 20k → 4 轮', () => {
    // (20000 - 5000 - 5000) / 2500 = 4
    expect(turnCount(P, 20_000)).toBe(4);
  });

  it('250k → 96 轮', () => {
    expect(turnCount(P, 250_000)).toBe(96);
  });

  it('规模不足以容纳前缀时为 0 轮；非整除向上取整', () => {
    expect(turnCount(P, 9_000)).toBe(0);
    expect(turnCount(P, 11_000)).toBe(1);
    expect(turnCount(P, 12_000)).toBe(1); // (12000-10000)/2500=0.8 → 1
  });
});

describe('simulateWithoutOm', () => {
  it('基线三类 token 按闭式公式累计', () => {
    // n=4、Δ=2500、half=1250、base=11250：
    // cacheWrite = 11250 + 3×2500 = 18750
    // cacheRead = 11250 + 13750 + 16250 = 41250
    // completion = 4×1250 = 5000
    const r = simulateWithoutOm(P, 20_000);
    expect(r.turns).toBe(4);
    expect(r.cacheWrite).toBe(18_750);
    expect(r.cacheRead).toBe(41_250);
    expect(r.completion).toBe(5_000);
    expect(r.observeCount).toBe(0);
    expect(r.reflectCount).toBe(0);
    expect(r.peakPromptTokens).toBe(5_000 + 5_000 + 3 * 2_500 + 1_250);
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
  it('首次观察在净压力 = 注入 + 未压缩量达到阈值时触发：第 17 轮（40000 + 5000 ≥ 45000）', () => {
    const r = simulateWithOm(P, 60_000);
    // n = (60000-10000)/2500 = 20 轮；W 在第 17 轮 pre-step 时为 16×2500 = 40000
    expect(r.observeCount).toBe(1);
    // 摘要 input = 指令 + 40000（注入内容不进摘要输入）；output = 3% × 40000 = 1200
    expect(r.summaryInputTokens).toBe(INSTRUCTION_TOKENS + 40_000);
    expect(r.summaryCompletionTokens).toBe(1_200);
    // 默认参数下 60k 规模不会触发反思
    expect(r.reflectCount).toBe(0);
  });

  it('250k 规模：约每 45000 tokens 一次观察、反思不触发、峰值远低于原始规模', () => {
    const r = simulateWithOm(P, 250_000);
    expect(r.turns).toBe(96);
    // 观察 5 次：首次 W=40000（含注入 5000），其后每 18 轮积累 45000 再触发
    expect(r.observeCount).toBe(5);
    expect(r.reflectCount).toBe(0); // H ≈ 5×1350 = 6750 < 120000
    // 峰值 ≈ 5000 + 50 + 5250 + 42500 + 1250 < 55000（远小于 250k）
    expect(r.peakPromptTokens).toBeLessThan(55_000);
    // 摘要 input = (指令 + 40000) + 4×(指令 + 45000)
    expect(r.summaryInputTokens).toBe(
      INSTRUCTION_TOKENS + 40_000 + 4 * (INSTRUCTION_TOKENS + 45_000),
    );
  });

  it('om 开启后总费用低于 om 关闭（默认参数 + Opus 价格）', () => {
    const row = computeRow(P, 250_000);
    expect(row.savings).toBeGreaterThan(0);
  });

  it('观察轮主请求缓存从替换点重新创建：该轮只缓存读取系统提示词', () => {
    // T=60k（n=20）：第 17 轮 pre-step 观察（替换点在最前，保留前缀 = 系统提示词）
    // cacheRead = 第 1–15 轮 prompt 合计(431250) + 第 17 轮截断读取(5000) + 第 18–20 轮(30000)
    // cacheWrite = 首轮 11250 + 常规增量 18×2500 + 第 17 轮重写 2500 + 摘要 input(指令 1000 + 40000)
    const r = simulateWithOm(P, 60_000);
    expect(r.cacheRead).toBe(431_250 + 5_000 + 30_000);
    expect(r.cacheWrite).toBe(11_250 + 18 * 2_500 + 2_500 + INSTRUCTION_TOKENS + 40_000);
    // om-off 对照：无截断，每轮读取完整上一轮 prompt
    const off = simulateWithoutOm(P, 60_000);
    expect(off.cacheRead).toBeGreaterThan(r.cacheRead);
    expect(off.cacheWrite).toBe(11_250 + 19 * 2_500);
  });
});

describe('simulateWithOm（注入遮蔽与反思）', () => {
  it('首次观察后注入消息遮蔽为 <sys> 空条目残留：峰值出现在观察前一轮请求', () => {
    const r = simulateWithOm(P, 60_000);
    // n=20；第 17 轮 pre-step 触发观察（该轮请求已压缩后发出），
    // 峰值 = 第 16 轮请求：5000 + 5000 + 37500 + 1250 = 48750
    expect(r.peakPromptTokens).toBe(5_000 + 5_000 + 37_500 + 1_250);
    // 观察后注入不再占上下文：残留 ≤ SYS_RESIDUAL_TOKENS 体现在后续 prompt 中
    expect(SYS_RESIDUAL_TOKENS).toBeLessThan(P.injectedTokens);
  });

  it('调小反思阈值时触发合并：反思摘要 input = 指令 + 当时 H 合计', () => {
    const params = withParams({ reflectThresholdTokens: 2_000, observeThresholdTokens: 45_000 });
    const r = simulateWithOm(params, 120_000);
    // n=44：观察 2 次（第 17/35 轮，H 依次 1200、2550）；第 36 轮 pre-step 反思（2550 ≥ 2000）
    expect(r.observeCount).toBe(2);
    expect(r.reflectCount).toBe(1);
    // 摘要 input = (1000+40000) + (1000+45000) + 反思(1000+2550) = 90550
    expect(r.summaryInputTokens).toBe(
      INSTRUCTION_TOKENS + 40_000 + (INSTRUCTION_TOKENS + 45_000) + (INSTRUCTION_TOKENS + 2_550),
    );
  });

  it('反思与观察可在同一 pre-step 先后触发', () => {
    const params = withParams({ reflectThresholdTokens: 100, observeThresholdTokens: 45_000 });
    const r = simulateWithOm(params, 120_000);
    expect(r.reflectCount).toBeGreaterThanOrEqual(1);
    expect(r.observeCount).toBeGreaterThanOrEqual(2);
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

  it('每行 savings = off.cost − on.cost', () => {
    for (const row of buildTable(P)) {
      expect(row.savings).toBeCloseTo(row.off.cost - row.on.cost, 10);
    }
  });
});
