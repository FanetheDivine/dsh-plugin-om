// om 成本计算器模型回归测试：无 om 基线、观察/反思触发、注入遮蔽、缓存失效与表格生成。
// 模型口径见 web/src/model.ts 文件头（页面成本表下方「假设」同步展示）。
// 会话为纯多 step 工具循环：每 step 模型接受 STEP_INPUT_TOKENS 输入驱动上下文增长，
// step 输出（STEP_OUTPUT_TOKENS）不计入公式；压缩会话按经验公式计费
// （缓存创建 1.3X、缓存读 1.75X、输出 压缩比×X + 5,000）；thinking 始终不压缩。
import { describe, expect, it } from 'vitest';
import {
  buildTable,
  COMPRESS_CACHE_READ_RATIO,
  COMPRESS_CACHE_WRITE_RATIO,
  COMPRESS_OUTPUT_FIXED_TOKENS,
  computeRow,
  DEFAULT_PARAMS,
  type ModelParams,
  STEP_INPUT_TOKENS,
  STEP_OUTPUT_TOKENS,
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

describe('常量', () => {
  it('step 输入 800 / 输出 320，压缩经验系数 1.3 / 1.75 / 5,000', () => {
    expect(STEP_INPUT_TOKENS).toBe(800);
    expect(STEP_OUTPUT_TOKENS).toBe(320);
    expect(COMPRESS_CACHE_WRITE_RATIO).toBe(1.3);
    expect(COMPRESS_CACHE_READ_RATIO).toBe(1.75);
    expect(COMPRESS_OUTPUT_FIXED_TOKENS).toBe(5000);
  });
});

describe('turnCount', () => {
  it('原始会话规模 = 前缀 + n·step输入：默认参数 20k → 7 轮', () => {
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
});

describe('simulateWithoutOm', () => {
  it('基线三类 token 按闭式公式累计，step 输出不进公式（输出桶恒为 0）', () => {
    // n=7、step输入=800、prefix=15000：
    // prompt_t = 15000 + (t-1)·800
    // cacheWrite = 15000 + 6×800 = 19800
    // cacheRead = 6×15000 + 800×(0+…+5) = 90000 + 12000 = 102000
    // completion = 0（step 输出不计入公式）
    const r = simulateWithoutOm(P, 20_000);
    expect(r.turns).toBe(7);
    expect(r.cacheWrite).toBe(19_800);
    expect(r.cacheRead).toBe(102_000);
    expect(r.completion).toBe(0);
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
    // 被压缩消息 X = 未压缩 step 输入 40000（注入内容不进摘要输入，thinking 始终不压缩）
    expect(r.summaryInputTokens).toBe(40_000);
    // 压缩会话输出 = 压缩比×X + 5,000 = 0.03×40000 + 5000
    expect(r.summaryOutputTokens).toBe(0.03 * 40_000 + COMPRESS_OUTPUT_FIXED_TOKENS);
    // 默认参数下 60k 规模不会触发反思
    expect(r.reflectCount).toBe(0);
  });

  it('压缩会话按经验公式计费：缓存创建 1.3X、缓存读 1.75X、输出 压缩比×X + 5,000', () => {
    const r = simulateWithOm(P, 60_000);
    // 仅 1 次观察（X=40000），压缩会话缓存桶 = 系数 × X
    const compressCacheWrite = COMPRESS_CACHE_WRITE_RATIO * 40_000;
    const compressCacheRead = COMPRESS_CACHE_READ_RATIO * 40_000;
    // 主会话缓存创建 = 首轮 15000 + 常规增量 49×800 + 观察轮重写 1250 + 6×800
    expect(r.cacheWrite).toBe(15_000 + 49 * 800 + 1_250 + 6 * 800 + compressCacheWrite);
    // 主会话缓存读取 = 前 50 轮累计 1675800 + 观察轮截断 10000 + 第 52–57 轮 79500
    expect(r.cacheRead).toBe(1_675_800 + 10_000 + 79_500 + compressCacheRead);
    // 输出桶只含压缩会话输出（step 输出不进公式）
    expect(r.completion).toBe(r.summaryOutputTokens);
    expect(r.completion).toBe(0.03 * 40_000 + COMPRESS_OUTPUT_FIXED_TOKENS);
  });

  it('观察轮主请求缓存从替换点重新创建：该轮只缓存读取系统提示词', () => {
    // T=60k（n=57）：第 51 轮 pre-step 观察（替换点在 history 首部，保留前缀 = 系统提示词）
    const r = simulateWithOm(P, 60_000);
    const off = simulateWithoutOm(P, 60_000);
    // om 开缓存读取 = 主会话 1765300 + 压缩会话 70000；om 关无截断且每轮复读完整上一轮
    expect(r.cacheRead).toBe(1_765_300 + COMPRESS_CACHE_READ_RATIO * 40_000);
    expect(off.cacheRead).toBeGreaterThan(1_765_300);
    expect(off.cacheWrite).toBe(15_000 + 56 * 800);
  });

  it('250k 规模：观察 5 次、反思不触发、峰值远低于原始规模', () => {
    const r = simulateWithOm(P, 250_000);
    expect(r.turns).toBe(294);
    // 观察 5 次：首次第 51 轮 W=40000（含注入 5000），其后每累计 45600+50 再触发
    // （第 108/165/222/279 轮）
    expect(r.observeCount).toBe(5);
    expect(r.reflectCount).toBe(0); // H = 1200 + 4×1368 = 6672 < 120000
    // 峰值出现在第 5 次观察前一轮（第 278 轮）：10000 + 50 + 5304 + 56×800 = 60154
    expect(r.peakPromptTokens).toBe(10_000 + 50 + 5_304 + 56 * 800);
    // 被压缩消息合计 = 40000 + 4×45600
    expect(r.summaryInputTokens).toBe(40_000 + 4 * 45_600);
    // 压缩会话输出合计 = Σ(压缩比×X + 5,000) = 0.03×222400 + 5×5000
    expect(r.summaryOutputTokens).toBe(
      0.03 * (40_000 + 4 * 45_600) + 5 * COMPRESS_OUTPUT_FIXED_TOKENS,
    );
  });

  it('默认参数下 250k：om 开仍更省，输出桶全部来自压缩会话输出', () => {
    const row = computeRow(P, 250_000);
    expect(row.savings).toBeGreaterThan(0);
    expect(row.off.completion).toBe(0);
    expect(row.on.completion).toBe(row.on.summaryOutputTokens);
  });

  it('压缩比既决定 history 块大小也参与计费：改压缩比输出桶与缓存桶都变', () => {
    const small = simulateWithOm(withParams({ compressionRatio: 0.03 }), 250_000);
    const large = simulateWithOm(withParams({ compressionRatio: 0.1 }), 250_000);
    // 默认阈值下不触发反思（0.1 时 H = 4000 + 4×4560 = 22240 < 120000），被压缩消息合计与压缩比无关
    expect(small.reflectCount).toBe(0);
    expect(large.reflectCount).toBe(0);
    expect(large.summaryInputTokens).toBe(small.summaryInputTokens);
    // 输出差 = 压缩比差 × 被压缩消息合计（固定开销 5,000×次数 不变）
    expect(large.summaryOutputTokens - small.summaryOutputTokens).toBeCloseTo(
      (0.1 - 0.03) * small.summaryInputTokens,
      10,
    );
    expect(large.completion).toBeGreaterThan(small.completion);
    // 块更大 → 上下文更大 → 缓存读写与峰值更高
    expect(large.peakPromptTokens).toBeGreaterThan(small.peakPromptTokens);
    expect(large.cacheRead).toBeGreaterThan(small.cacheRead);
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

  it('调小反思阈值时触发合并：反思按当时 H 合计作为被压缩消息 X 计费', () => {
    const params = withParams({ reflectThresholdTokens: 2_000, observeThresholdTokens: 45_000 });
    const r = simulateWithOm(params, 120_000);
    // n=132：观察 2 次（第 51/108 轮，X = 40000 / 45600）；
    // 反思 1 次：第 109 轮（H=1200+1368=2568 ≥ 2000 → H=77.04）
    expect(r.observeCount).toBe(2);
    expect(r.reflectCount).toBe(1);
    // 被压缩消息合计 = 40000 + 45600 + 反思 2568
    expect(r.summaryInputTokens).toBeCloseTo(40_000 + 45_600 + 2_568, 5);
    // 压缩会话输出 = Σ(压缩比×X + 5,000) = 0.03×88168 + 3×5000
    expect(r.summaryOutputTokens).toBeCloseTo(
      0.03 * (40_000 + 45_600 + 2_568) + 3 * COMPRESS_OUTPUT_FIXED_TOKENS,
      5,
    );
    // 缓存创建 = 主会话 120995.04（首轮 15000 + 49×800 + 观察重写 1250 + 56×800
    //   + 观察重写 1418 + 反思重写 927.04 + 23×800）+ 压缩会话 1.3×88168
    expect(r.cacheWrite).toBeCloseTo(
      15_000 + 49 * 800 + 1_250 + 56 * 800 + 1_418 + 927.04 + 23 * 800 + 1.3 * 88_168,
      5,
    );
    // 缓存读取 = 主会话 4022721.92 + 压缩会话 1.75×88168
    expect(r.cacheRead).toBeCloseTo(4_022_721.92 + 1.75 * 88_168, 5);
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
