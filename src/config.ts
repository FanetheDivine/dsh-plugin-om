/**
 * 插件配置：默认值与合并（preset 行 config 可覆盖全部键）。
 * 宽松校验：不合法的键被忽略、不合法的值回退默认值——配置错误不影响插件加载。
 */
import { sharedModelDir } from './embedding.ts';
import { isRecord } from './utils.ts';

/** 插件配置项（全部可选覆盖，未给出或留空的键用默认值）。 */
export type PluginConfig = {
  /** 压力阈值比例：压力 ≥ 窗口 × 该比例时触发自动压缩。 */
  thresholdRatio: number;
  /** 反思阈值比例：摘要（<history> 内容）≥ 窗口 × 该比例时由反思摘要调用精简合并。 */
  historyMergeRatio: number;
  /** 单次摘要（合并调用）生成上限（LLM maxTokens）。 */
  compressMaxTokens: number;
  /** 观察分块 token 边界：未压缩消息按该边界拆分为多块并行压缩（完整消息不跨块）。 */
  observeChunkTokens: number;
  /** 观察分块单块摘要的生成上限（LLM maxTokens；每块独立调用）。 */
  observeChunkMaxTokens: number;
  /** 压缩边界：其后不压缩消息数下限（正整数，尾部保留）。 */
  tailMessageCount: number;
  /** 摘要调用失败后的最大重试次数（不含首次尝试；总尝试次数 = 该值 + 1，默认 11）。 */
  compressRetryCount: number;
  /** 是否启用 OM 自动压缩（观察/反思）：false 时关闭自动压缩（recall 工具不受影响）。 */
  omEnabled: boolean;
  /** 步骤级（debug）日志开关：true 强制开启、false 强制关闭；缺省按 NODE_ENV !== 'production' 判定。 */
  debug: boolean;
  /** 是否注册 recall 工具（缺省 true；false 时不注册）。 */
  recallEnabled: boolean;
  /** 是否注册 recall-semantic 工具（缺省 true；false 时不注册、不触发模型下载）。 */
  semanticRecallEnabled: boolean;
  /** 语义召回嵌入模型目录（默认跨版本共享目录；可指向自定义模型目录）。 */
  modelDir: string;
};

/** 默认配置（冻结对象，resolveConfig 合并的基底；debug 缺省值在解析时按 NODE_ENV 判定）。 */
export const DEFAULT_CONFIG: Readonly<PluginConfig> = Object.freeze({
  thresholdRatio: 0.1,
  historyMergeRatio: 0.2,
  compressMaxTokens: 10000,
  observeChunkTokens: 30000,
  observeChunkMaxTokens: 5000,
  tailMessageCount: 10,
  compressRetryCount: 10,
  omEnabled: true,
  debug: false,
  recallEnabled: true,
  semanticRecallEnabled: true,
  modelDir: sharedModelDir(),
});

/** 数值配置键（仅接受有限数；整数键另校验整数性，不做取值区间限制）。 */
type NumberKey =
  | 'thresholdRatio'
  | 'historyMergeRatio'
  | 'compressMaxTokens'
  | 'observeChunkTokens'
  | 'observeChunkMaxTokens'
  | 'tailMessageCount'
  | 'compressRetryCount';

/** 数值键校验参数表：键名 + [integer]。不限制取值区间——用户提供的值按原样接受（便于调试）。 */
const NUMBER_KEYS: Array<[NumberKey, boolean]> = [
  ['thresholdRatio', false],
  ['historyMergeRatio', false],
  ['compressMaxTokens', true],
  ['observeChunkTokens', true],
  ['observeChunkMaxTokens', true],
  ['tailMessageCount', true],
  ['compressRetryCount', true],
];

/** 归一化原始配置输入：缺省 / null / 空串（含空白串）/ 非对象 视为空对象（全部用默认值）。 */
function normalizeConfigInput(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw === 'string' && raw.trim() === '') return {};
  if (!isRecord(raw)) return {};
  return raw;
}

/** 解析布尔配置值：缺省 / null / 空串 / 非 boolean 均回退默认值。 */
function resolveBoolean(raw: unknown, defaultValue: boolean): boolean {
  if (raw === undefined || raw === null) return defaultValue;
  if (typeof raw === 'string' && raw.trim() === '') return defaultValue;
  if (typeof raw === 'boolean') return raw;
  return defaultValue;
}

/**
 * 解析合并配置：未知键忽略、不合法值回退默认值，返回冻结的完整配置。
 * 允许所有配置留空——缺省 / null / 空串的键回退默认值，未给出的键亦取默认值。
 */
export function resolveConfig(raw?: unknown): Readonly<PluginConfig> {
  /** 原始输入（留空 / 不合法视为空对象）。 */
  const input = normalizeConfigInput(raw);
  /** 合并结果（以默认值为基底）。 */
  const config: PluginConfig = { ...DEFAULT_CONFIG };
  for (const [key, integer] of NUMBER_KEYS) {
    /** 该键的原始值（留空 / 不合法则跳过，保持默认值）。 */
    const value = input[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    if (integer && !Number.isInteger(value)) continue;
    config[key] = value as number;
  }
  /** OM 自动压缩开关（缺省启用；false 关闭自动压缩，recall 工具不受影响）。 */
  config.omEnabled = resolveBoolean(input.omEnabled, true);
  /** 步骤级日志开关（缺省按 NODE_ENV !== 'production' 判定）。 */
  config.debug = resolveBoolean(input.debug, process.env.NODE_ENV !== 'production');
  /** recall 工具开关（缺省启用）。 */
  config.recallEnabled = resolveBoolean(input.recallEnabled, true);
  /** recall-semantic 工具开关（缺省启用）。 */
  config.semanticRecallEnabled = resolveBoolean(input.semanticRecallEnabled, true);
  /** modelDir 原始值（留空 / 非空串以外回退默认；非空串必须为字符串）。 */
  const modelDir = input.modelDir;
  if (typeof modelDir === 'string' && modelDir.trim() !== '') {
    config.modelDir = modelDir;
  }
  return Object.freeze(config);
}
