/**
 * 插件配置：默认值、键校验与合并（preset 行 config 可覆盖全部键）。
 * 手写校验，保持零运行时外部依赖。
 */
import { sharedModelDir } from './embedding.ts';
import { assertNonEmptyString, assertNumber, fail, isRecord } from './utils.ts';

/**
 * 摘要模式：
 *  - fork（缺省）：fork 会话风格——复用主会话请求前缀（system/tools 与完整派生历史），
 *    充分利用 provider 前缀缓存；
 *  - new：新开会话风格——只注入本次要压缩的消息（XML 包裹），指令作为 system；
 *  - disable：关闭自动压缩（观察/反思均不触发）。
 */
export type SummaryMode = 'fork' | 'new' | 'disable';

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
  /** 摘要模式（缺省 fork；非法值在插件加载时报错）。 */
  summaryMode: SummaryMode;
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
  thresholdRatio: 0.5,
  historyMergeRatio: 0.2,
  compressMaxTokens: 4096,
  tailMessageCount: 10,
  summaryMode: 'fork',
  debug: false,
  recallEnabled: true,
  semanticRecallEnabled: true,
  modelDir: sharedModelDir(),
});

/** 合法配置键集合（未知键直接拒绝）。 */
const CONFIG_KEYS = new Set<string>([
  'thresholdRatio',
  'historyMergeRatio',
  'compressMaxTokens',
  'tailMessageCount',
  'summaryMode',
  'debug',
  'recallEnabled',
  'semanticRecallEnabled',
  'modelDir',
]);

/** 数值配置键（仅校验有限数；整数键另校验整数性，不做取值区间限制）。 */
type NumberKey = 'thresholdRatio' | 'historyMergeRatio' | 'compressMaxTokens' | 'tailMessageCount';

/** 数值键校验参数表：键名 + [integer]。不限制取值区间——用户提供的值按原样接受（便于调试）。 */
const NUMBER_KEYS: Array<[NumberKey, boolean]> = [
  ['thresholdRatio', false],
  ['historyMergeRatio', false],
  ['compressMaxTokens', true],
  ['tailMessageCount', true],
];

/** 归一化原始配置输入：缺省 / null / 空串（含空白串）视为空对象（全部用默认值）。 */
function normalizeConfigInput(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw === 'string' && raw.trim() === '') return {};
  if (!isRecord(raw)) fail('config must be an object');
  return raw;
}

/**
 * 解析摘要模式配置值：缺省 / 空串回退 fork；仅接受 'fork'/'new'/'disable'；
 * 其余值抛错（配置错误须立即可见）。
 */
export function resolveSummaryMode(raw: unknown): SummaryMode {
  if (raw === undefined || raw === null) return 'fork';
  if (typeof raw === 'string' && raw.trim() === '') return 'fork';
  if (raw === 'fork' || raw === 'new' || raw === 'disable') return raw;
  fail('config summaryMode must be "fork", "new" or "disable"');
}

/** 解析布尔配置值：缺省 / null / 空串回退默认值；必须为 boolean 否则抛错。 */
function resolveBoolean(name: string, raw: unknown, defaultValue: boolean): boolean {
  if (raw === undefined || raw === null) return defaultValue;
  if (typeof raw === 'string' && raw.trim() === '') return defaultValue;
  if (typeof raw === 'boolean') return raw;
  fail(`config ${name} must be a boolean`);
}

/**
 * 解析合并配置：校验未知键与数值/字符串类型，返回冻结的完整配置。
 * 允许所有配置留空——缺省 / null / 空串的键回退默认值，未给出的键亦取默认值。
 */
export function resolveConfig(raw?: unknown): Readonly<PluginConfig> {
  /** 原始输入（留空视为空对象）。 */
  const input = normalizeConfigInput(raw);
  for (const key of Object.keys(input)) {
    if (!CONFIG_KEYS.has(key)) fail(`unknown config key "${key}"`);
  }
  /** 合并结果（以默认值为基底）。 */
  const config: PluginConfig = { ...DEFAULT_CONFIG };
  for (const [key, integer] of NUMBER_KEYS) {
    /** 该键的原始值（留空则跳过，保持默认值）。 */
    const value = input[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    assertNumber(key, value, { integer });
    config[key] = value as number;
  }
  /** 摘要模式（缺省 fork；非法值报错）。 */
  config.summaryMode = resolveSummaryMode(input.summaryMode);
  /** 步骤级日志开关（缺省按 NODE_ENV !== 'production' 判定）。 */
  config.debug = resolveBoolean('debug', input.debug, process.env.NODE_ENV !== 'production');
  /** recall 工具开关（缺省启用）。 */
  config.recallEnabled = resolveBoolean('recallEnabled', input.recallEnabled, true);
  /** recall-semantic 工具开关（缺省启用）。 */
  config.semanticRecallEnabled = resolveBoolean(
    'semanticRecallEnabled',
    input.semanticRecallEnabled,
    true,
  );
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
