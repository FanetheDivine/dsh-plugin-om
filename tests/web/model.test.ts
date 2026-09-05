// om 成本计算器模型回归测试：无 om 基线、观察/反思触发、注入遮蔽、缓存失效与表格生成。
// 模型口径见 web/src/model.ts 文件头（页面成本表上方「表格假设」同步展示）。
// 会话为纯多 step 工具循环：thinking 只计补全、tool result 只写入驱动轮数。
import { describe, expect, it } from 'vitest';
import {
  buildTable,
  computeRow,
  DEFAULT_PARAMS,
  INSTRUCTION_TOKENS,
  type ModelParams,
  SUMMARY_THINKING_RATIO,
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
    // (20000 - 5000 - 5000) / 1500 = 6.67 → 7
    expect(turnCount(P, 20_000)).toBe(7);
  });

  it('250k → 160 轮', () => {
    expect(turnCount(P, 250_000)).toBe(160);
  });

  it('规模不足以容纳前缀时为 0 轮；非整除向上取整', () => {
    expect(turnCount(P, 9_000)).toBe(0);
    expect(turnCount(P, 11_000)).toBe(1);
    expect(turnCount(P, 12_000)).toBe(2); // (12000-10000)/1500=1.33 → 2
  });

  it('thinking 只输出不影响轮数：置 0 轮数不变', () => {
    expect(turnCount(withParams({ thinkingTokens: 0 }), 250_000)).toBe(160);
  });

  it('toolResult ≤ 0 视为会话不增长：任意规模均为 0 轮', () => {
    expect(turnCount(withParams({ toolResultTokens: 0 }), 250_000)).toBe(0);
    expect(turnCount(withParams({ toolResultTokens: -100 }), 250_000)).toBe(0);
  });
});

describe('simulateWithoutOm', () => {
  it('基线三类 token 按闭式公式累计', () => {
    // n=7、thinking=500、toolResult=1500、prefix=10000：
    // prompt_t = 10000 + (t-1)·1500
    // cacheWrite = 10000 + 6×1500 = 19000
    // cacheRead = 10000 + 11500 + 13000 + 14500 + 16000 + 17500 = 82500
    // completion = 7×500 = 3500
    const r = simulateWithoutOm(P, 20_000);
    expect(r.turns).toBe(7);
    expect(r.cacheWrite).toBe(19_000);
    expect(r.cacheRead).toBe(82_500);
    expect(r.completion).toBe(3_500);
    expect(r.observeCount).toBe(0);
    expect(r.reflectCount).toBe(0);
    expect(r.peakPromptTokens).toBe(5_000 + 5_000 + 6 * 1_500);
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
  it('首次观察在净压力 = 注入 + 未压缩量达到阈值时触发：第 28 轮（40500 + 5000 ≥ 45000）', () => {
    const r = simulateWithOm(P, 60_000);
    // n = (60000-10000)/1500 = 33.33 → 34 轮；W 在第 28 轮 pre-step 时为 27×1500 = 40500
    expect(r.observeCount).toBe(1);
    // 摘要 input = 指令 + 40500（注入内容不进摘要输入）；output = 3% × 40500 = 1215
    expect(r.summaryInputTokens).toBe(INSTRUCTION_TOKENS + 40_500);
    expect(r.summaryCompletionTokens).toBe(1_215);
    // 摘要 thinking = 50% × 摘要 input，只计补全
    expect(r.summaryThinkingTokens).toBe(SUMMARY_THINKING_RATIO * (INSTRUCTION_TOKENS + 40_500));
    // 默认参数下 60k 规模不会触发反思
    expect(r.reflectCount).toBe(0);
  });

  it('250k 规模：观察约每 45000 一次、反思不触发、峰值远低于原始规模', () => {
    const r = simulateWithOm(P, 250_000);
    expect(r.turns).toBe(160);
    // 观察 5 次：首次 W=40500（含注入 5000），其后 W 每累计 45000 再触发（第 58/88/118/148 轮）
    expect(r.observeCount).toBe(5);
    expect(r.reflectCount).toBe(0); // H ≈ 5×1350 = 6750 < 120000
    // 峰值出现在首次观察前一轮：≈ 5000 + 50 + 1200 + 42500 < 55000
    expect(r.peakPromptTokens).toBeLessThan(55_000);
    // 摘要 input = (指令 + 40500) + 4×(指令 + 45000)
    expect(r.summaryInputTokens).toBe(
      INSTRUCTION_TOKENS + 40_500 + 4 * (INSTRUCTION_TOKENS + 45_000),
    );
    expect(r.summaryCompletionTokens).toBe(1_215 + 4 * 1_350);
    // 每次摘要调用 thinking = 50% × 该次 input
    expect(r.summaryThinkingTokens).toBe(
      SUMMARY_THINKING_RATIO * (INSTRUCTION_TOKENS + 40_500 + 4 * (INSTRUCTION_TOKENS + 45_000)),
    );
  });

  it('摘要 thinking 按 50% × 摘要 input 计入 completion，不入缓存桶', () => {
    const r = simulateWithOm(P, 60_000);
    // n=34：主请求 thinking 34×500 = 17000；摘要 output 1215；摘要 thinking 0.5×(1000+40500) = 20750
    expect(r.summaryThinkingTokens).toBe(20_750);
    expect(r.completion).toBe(34 * 500 + 1_215 + 20_750);
    // 缓存创建只含摘要 input（1000+40500），不含摘要 thinking
    expect(r.cacheWrite).toBe(
      10_000 + 26 * 1_500 + 1_265 + 6 * 1_500 + INSTRUCTION_TOKENS + 40_500,
    );
  });

  it('默认参数下 250k：om 开仍更省，输出桶增量全部来自摘要 output 与摘要 thinking', () => {
    const row = computeRow(P, 250_000);
    expect(row.savings).toBeGreaterThan(0);
    // om 开的输出桶增量全部来自摘要 output 与摘要 thinking
    expect(row.on.completion - row.off.completion).toBe(
      row.on.summaryCompletionTokens + row.on.summaryThinkingTokens,
    );
  });

  it('观察轮主请求缓存从替换点重新创建：该轮只缓存读取系统提示词', () => {
    // T=60k（n=34）：第 28 轮 pre-step 观察（替换点在 history 首部，保留前缀 = 系统提示词）
    // cacheRead = 前 27 轮 prompt 累计(747500) + 第 28 轮截断读取(5000) + 第 29–34 轮(60090)
    // cacheWrite = 首轮 10000 + 常规增量 26×1500 + 第 28 轮重写 1265 + 6×1500 + 摘要 input(1000+40500)
    const r = simulateWithOm(P, 60_000);
    expect(r.cacheRead).toBe(747_500 + 5_000 + 60_090);
    expect(r.cacheWrite).toBe(
      10_000 + 26 * 1_500 + 1_265 + 6 * 1_500 + INSTRUCTION_TOKENS + 40_500,
    );
    // om-off 对照：无截断，每轮读取完整上一轮 prompt
    const off = simulateWithoutOm(P, 60_000);
    expect(off.cacheRead).toBeGreaterThan(r.cacheRead);
    expect(off.cacheWrite).toBe(10_000 + 33 * 1_500);
  });
});

describe('simulateWithOm（注入遮蔽与反思）', () => {
  it('首次观察后注入消息遮蔽为 <sys> 空条目残留：峰值出现在观察前一轮请求', () => {
    const r = simulateWithOm(P, 60_000);
    // n=34；第 28 轮 pre-step 触发观察（该轮请求已压缩后发出），
    // 峰值 = 第 27 轮请求：5000 + 5000 + 0 + 26×1500 = 49000
    expect(r.peakPromptTokens).toBe(5_000 + 5_000 + 26 * 1_500);
    // 观察后注入不再占上下文：残留 ≤ SYS_RESIDUAL_TOKENS 体现在后续 prompt 中
    expect(SYS_RESIDUAL_TOKENS).toBeLessThan(P.injectedTokens);
  });

  it('调小反思阈值时触发合并：反思摘要 input = 指令 + 当时 H 合计', () => {
    const params = withParams({ reflectThresholdTokens: 2_000, observeThresholdTokens: 45_000 });
    const r = simulateWithOm(params, 120_000);
    // n=74：观察 2 次（第 28/58 轮，H 依次 1215、2565）；第 59 轮 pre-step 反思（2565 ≥ 2000）
    expect(r.observeCount).toBe(2);
    expect(r.reflectCount).toBe(1);
    // 摘要 input = (1000+40500) + (1000+45000) + 反思(1000+2565) = 91065
    expect(r.summaryInputTokens).toBe(
      INSTRUCTION_TOKENS + 40_500 + (INSTRUCTION_TOKENS + 45_000) + (INSTRUCTION_TOKENS + 2_565),
    );
    // 三次摘要调用的 thinking 合计 = 150% × 摘要 input 合计
    expect(r.summaryThinkingTokens).toBeCloseTo(SUMMARY_THINKING_RATIO * 91_065, 10);
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
