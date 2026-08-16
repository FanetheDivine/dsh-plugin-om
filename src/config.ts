/**
 * 插件配置：默认值、键校验与合并（preset 行 config 可覆盖全部键）。
 * 手写校验，保持零运行时外部依赖。
 */
import { BUNDLED_MODEL_DIR } from './embedding.ts';
import { assertNonEmptyString, assertNumber, fail, isRecord } from './utils.ts';

/** 摘要模式：prefix=复用主会话请求前缀（缺省）；system=指令作为 system、消息作为输入。 */
export type SummaryMode = 'prefix' | 'system';

/** 摘要模式环境变量名（缺省 prefix；值 'system' 切换为 system 模式）。 */
export const SUMMARY_MODE_ENV = 'DSH_OM_SUMMARY_MODE';

/** 插件配置项（全部可选覆盖，未给出或留空的键用默认值）。 */
export type PluginConfig = {
  /** 压力阈值比例：压力 ≥ 窗口 × 该比例时触发自动压缩。 */
  thresholdRatio: number;
  /** 反思阈值比例：摘要（<om-history> 内容）≥ 窗口 × 该比例时由反思摘要调用精简合并。 */
  historyMergeRatio: number;
  /** 单次摘要（合并调用）生成上限（LLM maxTokens）。 */
  compressMaxTokens: number;
  /** 压缩边界：其后不压缩消息数下限（正整数，尾部保留）。 */
  tailMessageCount: number;
  /** 摘要模式（由环境变量 SUMMARY_MODE_ENV 决定，缺省 prefix）。 */
  summaryMode: SummaryMode;
  /** 语义召回嵌入模型目录（默认插件打包的本地模型；可指向自定义模型目录）。 */
  modelDir: string;
};

/** 默认配置（冻结对象，resolveConfig 合并的基底；summaryMode 由环境变量在解析时决定）。 */
export const DEFAULT_CONFIG: Readonly<PluginConfig> = Object.freeze({
  thresholdRatio: 0.5,
  historyMergeRatio: 0.2,
  compressMaxTokens: 4096,
  tailMessageCount: 10,
  summaryMode: 'prefix',
  modelDir: BUNDLED_MODEL_DIR,
});

/** 合法配置键集合（未知键直接拒绝）。 */
const CONFIG_KEYS = new Set<string>([
  'thresholdRatio',
  'historyMergeRatio',
  'compressMaxTokens',
  'tailMessageCount',
  'modelDir',
]);

/** 数值配置键（用于逐键校验其取值区间）。 */
type NumberKey = 'thresholdRatio' | 'historyMergeRatio' | 'compressMaxTokens' | 'tailMessageCount';

/** 数值键校验参数表：键名 + [min, max, integer]。 */
const NUMBER_KEYS: Array<[NumberKey, number, number, boolean]> = [
  ['thresholdRatio', 0.01, 1, false],
  ['historyMergeRatio', 0.01, 1, false],
  ['compressMaxTokens', 1, Infinity, true],
  ['tailMessageCount', 1, Infinity, true],
];

/** 归一化原始配置输入：缺省 / null / 空串（含空白串）视为空对象（全部用默认值）。 */
function normalizeConfigInput(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw === 'string' && raw.trim() === '') return {};
  if (!isRecord(raw)) fail('config must be an object');
  return raw;
}

/**
 * 解析摘要模式环境变量：缺省 / 空串回退 prefix；'system' 切换 system 模式；
 * 其余值抛错（环境变量配置错误须立即可见）。
 */
export function resolveSummaryModeFromEnv(env: Record<string, string | undefined>): SummaryMode {
  /** 环境变量原始值（trim 后判定）。 */
  const raw = env[SUMMARY_MODE_ENV]?.trim();
  if (raw === undefined || raw === '') return 'prefix';
  if (raw === 'prefix' || raw === 'system') return raw;
  fail(`${SUMMARY_MODE_ENV} must be "prefix" or "system"`);
}

/**
 * 解析合并配置：校验未知键与数值/字符串类型，返回冻结的完整配置。
 * 允许所有配置留空——缺省 / null / 空串的键回退默认值，未给出的键亦取默认值。
 * summaryMode 由环境变量 SUMMARY_MODE_ENV 决定（不随 preset 配置）。
 */
export function resolveConfig(raw?: unknown): Readonly<PluginConfig> {
  /** 原始输入（留空视为空对象）。 */
  const input = normalizeConfigInput(raw);
  for (const key of Object.keys(input)) {
    if (!CONFIG_KEYS.has(key)) fail(`unknown config key "${key}"`);
  }
  /** 合并结果（以默认值为基底）。 */
  const config: PluginConfig = { ...DEFAULT_CONFIG };
  for (const [key, min, max, integer] of NUMBER_KEYS) {
    /** 该键的原始值（留空则跳过，保持默认值）。 */
    const value = input[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    assertNumber(key, value, { min, max, integer });
    config[key] = value as number;
  }
  /** 摘要模式（环境变量覆盖默认值）。 */
  config.summaryMode = resolveSummaryModeFromEnv(process.env);
  /** modelDir 原始值（留空回退默认；非空串必须为字符串）。 */
  const modelDir = input.modelDir;
  if (modelDir !== undefined && modelDir !== null) {
    if (typeof modelDir === 'string' && modelDir.trim() !== '') {
      config.modelDir = modelDir;
    } else {
      assertNonEmptyString('modelDir', modelDir);
    }
  }
  return Object.freeze(config);
}
