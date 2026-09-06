/**
 * om 成本计算器的核心成本模型（纯函数，无 DOM 依赖；根 tests/web/model.test.ts 覆盖）。
 * 导出 TokenPrices / UsageBuckets / ScenarioResult / ModelParams / DEFAULT_PARAMS /
 * OPUS_PRICES / STEP_INPUT_TOKENS / STEP_OUTPUT_TOKENS /
 * COMPRESS_CACHE_WRITE_RATIO / COMPRESS_CACHE_READ_RATIO / COMPRESS_OUTPUT_FIXED_TOKENS /
 * SYS_RESIDUAL_TOKENS / TABLE_MIN_TOKENS / TABLE_MAX_TOKENS /
 * turnCount / simulateWithoutOm / simulateWithOm / computeRow / buildTable。
 *
 * 模型口径（与页面成本表下方的「假设」同步展示）：
 * - 会话为纯多 step（工具循环）消息：每个 step 模型接受 STEP_INPUT_TOKENS 数据
 *   （text、tool-args、用户&系统消息、tool-result），是原始对话量增长的唯一来源；
 *   每个 step 模型输出 STEP_OUTPUT_TOKENS（thinking、text、tool-args），不计入公式
 * - 固定前缀 = 系统提示词 S + dsh 注入消息 D（AGENTS.md、skill 定义等，以系统消息注入），
 *   每轮请求重复发送；按前缀缓存计费：首轮缓存创建完整前缀，
 *   此后每轮缓存读取上一轮 prompt、缓存创建本轮新增量
 * - om 关闭：上下文每轮按 STEP_INPUT_TOKENS 增长，
 *   n = (T − S − D) / STEP_INPUT_TOKENS 轮后原始会话达到 T
 * - om 开启：pre-step 先反思后观察；净压力 ≈ 未压缩 step 输入量 + 未遮蔽注入量，
 *   ≥ 观察阈值触发观察压缩（被压缩消息 = 未压缩 step 输入，旧块保留、未压缩量清零）；
 *   首次观察把 dsh 注入消息遮蔽为 <sys> 空条目（内容不再占上下文、不进摘要输入）；
 *   history 块合计 ≥ 反思阈值触发合并（全部块压缩为一条）；thinking 始终不压缩
 * - 压缩会话（观察/反思）为独立新会话，按经验公式计费（X = 本次被压缩消息 tokens）：
 *   缓存创建 ≈ 1.3X、缓存读 ≈ 1.75X、输出 ≈ 压缩比 × X + 5,000；
 *   history 块增量 = 压缩比 × X，压缩比同时决定块在上下文中的大小与压缩输出
 * - 压缩替换破坏前缀缓存：该轮主请求只缓存读取替换点之前的前缀，其余重新缓存创建
 * - 忽略项：首条用户消息与最终回复文本、工具定义 tokens（会推迟观察触发）、
 *   XML 渲染开销、尾部保留消息、429 重试
 */

/** 三类 token 单价（USD / 1M tokens）。 */
export type TokenPrices = {
  /** 补全（输出）价格。 */
  completion: number;
  /** 缓存读取价格。 */
  cacheRead: number;
  /** 缓存创建价格。 */
  cacheWrite: number;
};

/** 三类 token 消耗量（tokens）。 */
export type UsageBuckets = {
  /** 补全 tokens（压缩会话输出；step 输出不计入公式）。 */
  completion: number;
  /** 缓存读取 tokens（主会话 + 压缩会话）。 */
  cacheRead: number;
  /** 缓存创建 tokens（主会话 + 压缩会话）。 */
  cacheWrite: number;
};

/** 单个场景（om 开 / 关）的模拟结果。 */
export type ScenarioResult = UsageBuckets & {
  /** 总费用（USD，三类 token 分别计价求和）。 */
  cost: number;
  /** 峰值主请求 prompt tokens（om 的上下文收益参考）。 */
  peakPromptTokens: number;
  /** 会话总轮数。 */
  turns: number;
  /** 观察压缩触发次数（om 关闭恒为 0）。 */
  observeCount: number;
  /** 反思合并触发次数（om 关闭恒为 0）。 */
  reflectCount: number;
  /** 被压缩消息 tokens 合计（各次压缩会话的输入 X 之和，压缩会话缓存桶按其系数折算并入）。 */
  summaryInputTokens: number;
  /** 压缩会话输出 tokens 合计 = Σ(压缩比 × X + 5,000)（已并入 completion）。 */
  summaryOutputTokens: number;
};

/** 成本模型全部可调参数。 */
export type ModelParams = {
  /** 系统提示词 tokens（S）：每轮重复发送的固定前缀之一。 */
  systemPromptTokens: number;
  /** dsh 注入消息 tokens（D）：AGENTS.md / skill 定义等系统消息，首次观察压缩后遮蔽为空条目。 */
  injectedTokens: number;
  /** 观察阈值（tokens）：净压力 ≥ 该值触发观察压缩。 */
  observeThresholdTokens: number;
  /** 反思阈值（tokens）：history 块合计 ≥ 该值触发合并。 */
  reflectThresholdTokens: number;
  /** 压缩比：摘要输出 / 被压缩消息，决定压缩后 history 块在上下文中的大小，并参与压缩输出计费。 */
  compressionRatio: number;
  /** 对比表行步长（tokens）。 */
  tableStepTokens: number;
  /** 三类 token 单价（USD / 1M tokens）。 */
  prices: TokenPrices;
};

/** Opus 定价（USD / 1M tokens）：成本表默认单价。 */
export const OPUS_PRICES: Readonly<TokenPrices> = Object.freeze({
  completion: 25,
  cacheRead: 0.5,
  cacheWrite: 6.25,
});

/** 每个 step 模型接受的输入数据 tokens（text、tool-args、用户&系统消息、tool-result），驱动上下文增长。 */
export const STEP_INPUT_TOKENS = 800;

/** 每个 step 模型输出的 tokens（thinking、text、tool-args），不计入公式。 */
export const STEP_OUTPUT_TOKENS = 320;

/** 压缩会话未缓存输入相对被压缩消息的经验系数（缓存创建桶）。 */
export const COMPRESS_CACHE_WRITE_RATIO = 1.3;

/** 压缩会话缓存读相对被压缩消息的经验系数（缓存读取桶）。 */
export const COMPRESS_CACHE_READ_RATIO = 1.75;

/** 压缩会话每次调用的固定输出开销 tokens（输出桶，含指令与多轮工具循环开销）。 */
export const COMPRESS_OUTPUT_FIXED_TOKENS = 5000;

/** dsh 注入消息被遮蔽后的 <sys> 空条目残留 tokens（近似常数）。 */
export const SYS_RESIDUAL_TOKENS = 50;

/** 对比表原始会话规模下限（tokens）。 */
export const TABLE_MIN_TOKENS = 20_000;

/** 对比表原始会话规模上限（tokens）。 */
export const TABLE_MAX_TOKENS = 250_000;

/** 默认参数：阈值取插件当前默认值，价格取 Opus 定价。 */
export const DEFAULT_PARAMS: Readonly<ModelParams> = Object.freeze({
  systemPromptTokens: 10_000,
  injectedTokens: 5000,
  observeThresholdTokens: 45_000,
  reflectThresholdTokens: 120_000,
  compressionRatio: 0.03,
  tableStepTokens: 10_000,
  prices: OPUS_PRICES,
});

/** 三类 bucket 求和计价（USD）。 */
function costOf(usage: UsageBuckets, prices: Readonly<TokenPrices>): number {
  return (
    (usage.completion * prices.completion +
      usage.cacheRead * prices.cacheRead +
      usage.cacheWrite * prices.cacheWrite) /
    1_000_000
  );
}

/** 会话总轮数：原始会话规模 T 达到 (S + D + n·step输入) 时的 n（不足一轮按 0 计）。 */
export function turnCount(params: Readonly<ModelParams>, targetTokens: number): number {
  const conversation = targetTokens - params.systemPromptTokens - params.injectedTokens;
  if (conversation <= 0) return 0;
  return Math.ceil(conversation / STEP_INPUT_TOKENS);
}

/**
 * om 关闭的全会话模拟：逐轮累计三类 token。
 * 每轮主请求 prompt = 固定前缀 + 已写回的 step 输入累计，首轮整段缓存创建；
 * 此后每轮缓存读取上一轮 prompt、缓存创建本轮新增 step 输入；
 * step 输出不计入公式，输出桶恒为 0。
 */
export function simulateWithoutOm(
  params: Readonly<ModelParams>,
  targetTokens: number,
): ScenarioResult {
  const n = turnCount(params, targetTokens);
  const step = STEP_INPUT_TOKENS;
  const prefix = params.systemPromptTokens + params.injectedTokens;
  const usage: UsageBuckets = { completion: 0, cacheRead: 0, cacheWrite: 0 };
  let prevPrompt: number | null = null;
  let peak = 0;
  for (let t = 1; t <= n; t += 1) {
    const prompt = prefix + (t - 1) * step;
    if (prevPrompt === null) {
      usage.cacheWrite += prompt;
    } else {
      usage.cacheRead += prevPrompt;
      usage.cacheWrite += step;
    }
    peak = Math.max(peak, prompt);
    prevPrompt = prompt;
  }
  return {
    ...usage,
    cost: costOf(usage, params.prices),
    peakPromptTokens: peak,
    turns: n,
    observeCount: 0,
    reflectCount: 0,
    summaryInputTokens: 0,
    summaryOutputTokens: 0,
  };
}

/**
 * om 开启的全会话模拟：每轮先 pre-step（反思 → 观察）再发主请求；
 * 每轮 STEP_INPUT_TOKENS 写回未压缩量并计入缓存创建；step 输出不计入公式。
 * - 反思：H ≥ 反思阈值时合并全部块（H ← 压缩比 × H），被压缩消息 X = H；
 *   替换整个块区段，主请求仅缓存读取系统提示词
 * - 观察：净压力（未压缩 step 输入量 + 未遮蔽注入量）≥ 观察阈值时压缩全部未压缩消息
 *   （X = 未压缩 step 输入，不含注入内容），旧块保留、未压缩量清零、
 *   注入量遮蔽为残留常数；主请求缓存读取系统提示词 + 旧块
 * - 每次压缩会话按经验公式计费：缓存创建 ≈ 1.3X、缓存读 ≈ 1.75X、
 *   输出 ≈ 压缩比 × X + 5,000；history 块增量 = 压缩比 × X
 * - 压缩轮之外：主请求缓存读取上一轮 prompt、缓存创建本轮 step 输入
 */
export function simulateWithOm(
  params: Readonly<ModelParams>,
  targetTokens: number,
): ScenarioResult {
  const n = turnCount(params, targetTokens);
  const step = STEP_INPUT_TOKENS;
  const ratio = params.compressionRatio;
  const usage: UsageBuckets = { completion: 0, cacheRead: 0, cacheWrite: 0 };
  let summaryInput = 0;
  let summaryOutput = 0;
  let observeCount = 0;
  let reflectCount = 0;
  let uncompressed = 0; // 未压缩 step 输入量 W
  let history = 0; // <history> 块 token 合计 H
  let injectedActive = params.injectedTokens; // 未遮蔽的注入量（首次观察后降为残留常数）
  let prevPrompt: number | null = null;
  let peak = 0;
  /** 压缩会话计费：X = 本次被压缩消息 tokens，按经验公式折算进三类桶。 */
  const billCompression = (x: number) => {
    summaryInput += x;
    summaryOutput += ratio * x + COMPRESS_OUTPUT_FIXED_TOKENS;
    usage.cacheRead += COMPRESS_CACHE_READ_RATIO * x;
    usage.cacheWrite += COMPRESS_CACHE_WRITE_RATIO * x;
  };
  for (let t = 1; t <= n; t += 1) {
    // pre-step：压缩发生时该轮主请求的缓存读取被替换点截断（null 表示未压缩）
    let cacheRead: number | null = null;
    // 反思 pass：全部块合计 ≥ 反思阈值 → 合并为一条（替换整个块区段）
    if (history > 0 && history >= params.reflectThresholdTokens) {
      billCompression(history);
      history = history * ratio;
      reflectCount += 1;
      cacheRead = params.systemPromptTokens;
    }
    // 观察 pass：净压力 = 未压缩量 + 未遮蔽注入量 ≥ 观察阈值 → 压缩全部未压缩消息
    const netPressure = uncompressed + injectedActive;
    if (netPressure >= params.observeThresholdTokens) {
      const preservedBlocks = history; // 旧块保留在缓存前缀中
      const compressed = uncompressed; // 被压缩消息 = 未压缩 step 输入（thinking 始终不压缩）
      billCompression(compressed);
      history += compressed * ratio;
      uncompressed = 0;
      injectedActive = Math.min(injectedActive, SYS_RESIDUAL_TOKENS);
      observeCount += 1;
      cacheRead = params.systemPromptTokens + preservedBlocks;
    }
    // 主请求：prompt = 系统提示词 + 未遮蔽注入 + 块合计 + 未压缩 step 输入量
    const prompt = params.systemPromptTokens + injectedActive + history + uncompressed;
    if (cacheRead !== null) {
      usage.cacheRead += cacheRead;
      usage.cacheWrite += Math.max(0, prompt - cacheRead);
    } else if (prevPrompt === null) {
      usage.cacheWrite += prompt;
    } else {
      usage.cacheRead += prevPrompt;
      usage.cacheWrite += Math.max(0, prompt - prevPrompt);
    }
    peak = Math.max(peak, prompt);
    prevPrompt = prompt;
    // 本轮 step 输入写回未压缩量
    uncompressed += step;
  }
  usage.completion += summaryOutput;
  return {
    ...usage,
    cost: costOf(usage, params.prices),
    peakPromptTokens: peak,
    turns: n,
    observeCount,
    reflectCount,
    summaryInputTokens: summaryInput,
    summaryOutputTokens: summaryOutput,
  };
}

/** 对比表单行：目标规模 + om 开/关两场景 + 费用节省（om 关 − om 开，正数即 om 更省）。 */
export type CostRow = {
  /** 原始会话规模（tokens，含系统提示词与注入消息）。 */
  targetTokens: number;
  /** om 关闭场景。 */
  off: ScenarioResult;
  /** om 开启场景。 */
  on: ScenarioResult;
  /** 费用节省（USD）。 */
  savings: number;
};

/** 计算单个目标规模下的对比行。 */
export function computeRow(params: Readonly<ModelParams>, targetTokens: number): CostRow {
  const off = simulateWithoutOm(params, targetTokens);
  const on = simulateWithOm(params, targetTokens);
  return { targetTokens, off, on, savings: off.cost - on.cost };
}

/**
 * 构建对比表全部行：目标规模从下限起按步长递增到上限，末行不足一个步长时并入上限行。
 * 步长下限 1000 是行数防护（20k–250k 区间至多 230 行），避免小步长撑爆 DOM。
 */
export function buildTable(params: Readonly<ModelParams>): CostRow[] {
  const step = Math.max(1000, params.tableStepTokens);
  const rows: CostRow[] = [];
  for (let target = TABLE_MIN_TOKENS; target < TABLE_MAX_TOKENS; target += step) {
    rows.push(computeRow(params, target));
  }
  rows.push(computeRow(params, TABLE_MAX_TOKENS));
  return rows;
}
