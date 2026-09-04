/**
 * om 成本计算器的核心成本模型（纯函数，无 DOM 依赖；根 tests/web/model.test.ts 覆盖）。
 * 导出 TokenPrices / UsageBuckets / ScenarioResult / ModelParams / DEFAULT_PARAMS /
 * OPUS_PRICES / INSTRUCTION_TOKENS / SYS_RESIDUAL_TOKENS / TABLE_MIN_TOKENS /
 * TABLE_MAX_TOKENS / simulateWithoutOm / simulateWithOm / computeRow / buildTable。
 *
 * 模型口径（页面「模型假设」一节同步展示）：
 * - 会话从固定前缀开始：系统提示词 S + dsh 注入消息 D（AGENTS.md、skill 定义等，
 *   以系统消息注入），每轮请求重复发送；按前缀缓存计费：首轮缓存创建完整前缀，
 *   此后每轮缓存读取上一轮 prompt、缓存创建本轮新增量
 * - 每轮新增 Δ tokens：用户消息与模型回复各 Δ/2，回复按补全价格计费
 * - om 关闭：上下文持续增长，n = (T − S − D) / Δ 轮后原始会话达到 T
 * - om 开启：pre-step 先反思后观察；净压力 ≈ 未压缩对话量 + 未遮蔽注入量，
 *   ≥ 观察阈值触发观察压缩（摘要 = 压缩比 × 被压缩量，旧块保留、未压缩量清零）；
 *   首次观察把 dsh 注入消息遮蔽为 <sys> 空条目（内容不再占上下文、不进摘要输入）；
 *   history 块合计 ≥ 反思阈值触发合并（全部块压缩为一条）
 * - 摘要调用为独立新会话：请求同样写入缓存，input = 指令 + 被压缩内容
 *   （全量计入缓存创建桶），output = 压缩比 × 输入
 * - 压缩替换破坏前缀缓存：该轮主请求只缓存读取替换点之前的前缀，其余重新缓存创建
 * - 忽略项：工具定义 tokens（会推迟观察触发）、XML 渲染开销、尾部保留消息、429 重试
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
  /** 补全 tokens（含摘要调用 output）。 */
  completion: number;
  /** 缓存读取 tokens。 */
  cacheRead: number;
  /** 缓存创建 tokens（含摘要调用 input）。 */
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
  /** 摘要调用 input tokens 合计（已并入 cacheWrite）。 */
  summaryInputTokens: number;
  /** 摘要调用 output tokens 合计（已并入 completion）。 */
  summaryCompletionTokens: number;
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
  /** 压缩比：摘要输出 / 被压缩内容（0–1）。 */
  compressionRatio: number;
  /** 每轮新增 tokens（Δ）：用户消息与模型回复各半。 */
  turnDeltaTokens: number;
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

/** 摘要调用的共享指令 tokens（buildHistoryPrompt 的近似规模）。 */
export const INSTRUCTION_TOKENS = 1000;

/** dsh 注入消息被遮蔽后的 <sys> 空条目残留 tokens（近似常数）。 */
export const SYS_RESIDUAL_TOKENS = 50;

/** 对比表原始会话规模下限（tokens）。 */
export const TABLE_MIN_TOKENS = 20_000;

/** 对比表原始会话规模上限（tokens）。 */
export const TABLE_MAX_TOKENS = 250_000;

/** 默认参数：阈值取插件当前默认值，前缀与价格取需求默认值。 */
export const DEFAULT_PARAMS: Readonly<ModelParams> = Object.freeze({
  systemPromptTokens: 5000,
  injectedTokens: 5000,
  observeThresholdTokens: 45_000,
  reflectThresholdTokens: 120_000,
  compressionRatio: 0.03,
  turnDeltaTokens: 2500,
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

/** 会话总轮数：原始会话规模 T 达到 (S + D + n·Δ) 时的 n（不足一轮按 0 计；Δ ≤ 0 视为会话不增长，恒为 0）。 */
export function turnCount(params: Readonly<ModelParams>, targetTokens: number): number {
  const conversation = targetTokens - params.systemPromptTokens - params.injectedTokens;
  if (conversation <= 0 || params.turnDeltaTokens <= 0) return 0;
  return Math.ceil(conversation / params.turnDeltaTokens);
}

/**
 * om 关闭的全会话模拟：逐轮累计三类 token。
 * 首轮缓存创建完整 prompt；此后每轮缓存读取上一轮 prompt、缓存创建新增 Δ；
 * 每轮补全 Δ/2。
 */
export function simulateWithoutOm(
  params: Readonly<ModelParams>,
  targetTokens: number,
): ScenarioResult {
  const n = turnCount(params, targetTokens);
  const half = params.turnDeltaTokens / 2;
  const base = params.systemPromptTokens + params.injectedTokens + half;
  const usage: UsageBuckets = { completion: 0, cacheRead: 0, cacheWrite: 0 };
  let prevPrompt: number | null = null;
  let peak = 0;
  for (let t = 1; t <= n; t += 1) {
    const prompt = base + (t - 1) * params.turnDeltaTokens;
    if (prevPrompt === null) {
      usage.cacheWrite += prompt;
    } else {
      usage.cacheRead += prevPrompt;
      usage.cacheWrite += prompt - prevPrompt;
    }
    usage.completion += half;
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
    summaryCompletionTokens: 0,
  };
}

/**
 * om 开启的全会话模拟：每轮先 pre-step（反思 → 观察）再发主请求。
 * - 反思：H ≥ 反思阈值时合并全部块（H ← 压缩比 × H），摘要调用 input = 指令 + H；
 *   替换整个块区段，主请求仅缓存读取系统提示词
 * - 观察：净压力（未压缩量 + 未遮蔽注入量）≥ 观察阈值时压缩全部未压缩量
 *   （摘要 input = 指令 + 未压缩量，不含注入内容），旧块保留、未压缩量清零、
 *   注入量遮蔽为残留常数；主请求缓存读取系统提示词 + 旧块
 * - 压缩轮之外：主请求缓存读取上一轮 prompt、缓存创建新增量；每轮补全 Δ/2
 */
export function simulateWithOm(
  params: Readonly<ModelParams>,
  targetTokens: number,
): ScenarioResult {
  const n = turnCount(params, targetTokens);
  const delta = params.turnDeltaTokens;
  const half = delta / 2;
  const ratio = params.compressionRatio;
  const usage: UsageBuckets = { completion: 0, cacheRead: 0, cacheWrite: 0 };
  let summaryInput = 0;
  let summaryCompletion = 0;
  let observeCount = 0;
  let reflectCount = 0;
  let uncompressed = 0; // 未压缩对话量 W
  let history = 0; // <history> 块 token 合计 H
  let injectedActive = params.injectedTokens; // 未遮蔽的注入量（首次观察后降为残留常数）
  let prevPrompt: number | null = null;
  let peak = 0;
  for (let t = 1; t <= n; t += 1) {
    // pre-step：压缩发生时该轮主请求的缓存读取被替换点截断（null 表示未压缩）
    let cacheRead: number | null = null;
    // 反思 pass：全部块合计 ≥ 反思阈值 → 合并为一条（替换整个块区段）
    if (history > 0 && history >= params.reflectThresholdTokens) {
      summaryInput += INSTRUCTION_TOKENS + history;
      summaryCompletion += history * ratio;
      history = history * ratio;
      reflectCount += 1;
      cacheRead = params.systemPromptTokens;
    }
    // 观察 pass：净压力 = 未压缩量 + 未遮蔽注入量 ≥ 观察阈值 → 压缩全部未压缩量
    const netPressure = uncompressed + injectedActive;
    if (netPressure >= params.observeThresholdTokens) {
      const preservedBlocks = history; // 旧块保留在缓存前缀中
      summaryInput += INSTRUCTION_TOKENS + uncompressed;
      summaryCompletion += uncompressed * ratio;
      history += uncompressed * ratio;
      uncompressed = 0;
      injectedActive = Math.min(injectedActive, SYS_RESIDUAL_TOKENS);
      observeCount += 1;
      cacheRead = params.systemPromptTokens + preservedBlocks;
    }
    // 主请求：prompt = 系统提示词 + 未遮蔽注入 + 块合计 + 未压缩量 + 本轮用户消息
    const prompt = params.systemPromptTokens + injectedActive + history + uncompressed + half;
    if (cacheRead !== null) {
      usage.cacheRead += cacheRead;
      usage.cacheWrite += Math.max(0, prompt - cacheRead);
    } else if (prevPrompt === null) {
      usage.cacheWrite += prompt;
    } else {
      usage.cacheRead += prevPrompt;
      usage.cacheWrite += Math.max(0, prompt - prevPrompt);
    }
    usage.completion += half;
    peak = Math.max(peak, prompt);
    prevPrompt = prompt;
    // 本轮用户消息 + 模型回复计入未压缩量
    uncompressed += delta;
  }
  usage.cacheWrite += summaryInput;
  usage.completion += summaryCompletion;
  return {
    ...usage,
    cost: costOf(usage, params.prices),
    peakPromptTokens: peak,
    turns: n,
    observeCount,
    reflectCount,
    summaryInputTokens: summaryInput,
    summaryCompletionTokens: summaryCompletion,
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
