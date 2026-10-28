/**
 * 插件配置：宿主 Config 严格校验、volatile 引用读取与兼容 YAML 的宽松合并。
 * 导出 Config / PluginConfig / DEFAULT_CONFIG / currentConfig / resolveConfig。
 * 宽松解析时未知键忽略、非法值回退默认值。
 */
import Schema from '@deepseek-ai/schemastery';
import { sharedModelDir } from './embedding.ts';
import { isRecord } from './utils.ts';

/** 插件配置项（全部可选覆盖，未给出或留空的键用默认值）。 */
export type PluginConfig = {
  /** 观察阈值（tokens）：净压力 ≥ 该值时触发观察压缩。 */
  observeThresholdTokens: number;
  /** 反思阈值（tokens）：<history> 块 token 合计 ≥ 该值时后台归档较早的块，尾部保留合计不超过其 1/3。 */
  reflectThresholdTokens: number;
  /** 单次摘要生成上限（LLM maxTokens）；undefined 表示不设置，由模型适配器默认值决定。 */
  compressMaxTokens: number | undefined;
  /** 遇 429 限流后下一次摘要请求前的等待毫秒数（全局冷却期）。 */
  rateLimitWaitMs: number;
  /** 观察触发后延迟执行的等待完整消息条数（新增完整消息数达到该值才执行压缩；0 表示触发当轮立即执行）。 */
  tailMessageCount: number;
  /** 工具循环 getHistory 输出是否携带 reasoning 参考条目（true 时不携带，压缩指令也省略其说明行）。 */
  compressSkipReasoning: boolean;
  /** 是否注入进度提醒。 */
  progressReminderEnabled: boolean;
  /** 无记录活动达标时是否重发进度提醒（false 时仅在表层缺失时补发）。 */
  progressReminderIdleEnabled: boolean;
  /** 重发判定：静默窗口内已结束模型 step 数下限（≥ 1）。 */
  progressReminderIdleSteps: number;
  /** 重发判定：静默窗口内工具调用数须超过该值（≥ 0）。 */
  progressReminderIdleToolCalls: number;
  /** 步骤级日志开关（缺省按 NODE_ENV !== 'production' 判定）。 */
  debug: boolean;
  /** 是否为 recall 的 query 启用语义检索（false 时按字符串匹配，不触发模型下载）。 */
  semanticRecallEnabled: boolean;
  /** 语义增强嵌入模型目录。 */
  modelDir: string;
  /** 压缩请求覆盖的 provider（与 compressModel 成对生效，任一缺失回落会话路由）。 */
  compressProvider: string | undefined;
  /** 压缩请求覆盖的 model（与 compressProvider 成对生效，任一缺失回落会话路由）。 */
  compressModel: string | undefined;
  /** 压缩请求的思考等级（配置值不被目标模型支持时降级为模型默认并告警）。 */
  compressReasoningEffort: string | undefined;
};

/** 默认配置（冻结对象，resolveConfig 合并的基底；debug 缺省值在解析时按 NODE_ENV 判定）。 */
export const DEFAULT_CONFIG: Readonly<PluginConfig> = Object.freeze({
  observeThresholdTokens: 35000,
  reflectThresholdTokens: 80000,
  compressMaxTokens: undefined,
  rateLimitWaitMs: 60000,
  tailMessageCount: 20,
  compressSkipReasoning: true,
  progressReminderEnabled: true,
  progressReminderIdleEnabled: false,
  progressReminderIdleSteps: 4,
  progressReminderIdleToolCalls: 10,
  debug: false,
  semanticRecallEnabled: true,
  modelDir: sharedModelDir(),
  compressProvider: undefined,
  compressModel: undefined,
  compressReasoningEffort: undefined,
});

/** debug 开关 schema：缺省按 NODE_ENV !== 'production' 判定。 */
function debugSchema() {
  return Schema.boolean()
    .default(process.env.NODE_ENV !== 'production')
    .volatile();
}

/** 宿主保存时严格校验，所有字段均为稳定 volatile 引用，运行时由 Loader 原地提交。 */
export const Config = Schema.object({
  observeThresholdTokens: Schema.number()
    .step(1)
    .default(DEFAULT_CONFIG.observeThresholdTokens)
    .volatile(),
  reflectThresholdTokens: Schema.number()
    .step(1)
    .default(DEFAULT_CONFIG.reflectThresholdTokens)
    .volatile(),
  compressMaxTokens: Schema.number().step(1).volatile(),
  rateLimitWaitMs: Schema.number().step(1).default(DEFAULT_CONFIG.rateLimitWaitMs).volatile(),
  tailMessageCount: Schema.number().step(1).default(DEFAULT_CONFIG.tailMessageCount).volatile(),
  compressSkipReasoning: Schema.boolean().default(DEFAULT_CONFIG.compressSkipReasoning).volatile(),
  progressReminderEnabled: Schema.boolean()
    .default(DEFAULT_CONFIG.progressReminderEnabled)
    .volatile(),
  progressReminderIdleEnabled: Schema.boolean()
    .default(DEFAULT_CONFIG.progressReminderIdleEnabled)
    .volatile(),
  progressReminderIdleSteps: Schema.number()
    .step(1)
    .min(1)
    .default(DEFAULT_CONFIG.progressReminderIdleSteps)
    .volatile(),
  progressReminderIdleToolCalls: Schema.number()
    .step(1)
    .min(0)
    .default(DEFAULT_CONFIG.progressReminderIdleToolCalls)
    .volatile(),
  debug: debugSchema(),
  semanticRecallEnabled: Schema.boolean().default(DEFAULT_CONFIG.semanticRecallEnabled).volatile(),
  modelDir: Schema.string().default(DEFAULT_CONFIG.modelDir).volatile(),
  compressProvider: Schema.string().volatile(),
  compressModel: Schema.string().volatile(),
  compressReasoningEffort: Schema.string().volatile(),
}).default({});

/** 取出 keys 对应的当前值：volatile 引用解开 get()，原始值原样保留；非对象返回 undefined。 */
function readVolatile(
  config: unknown,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  if (!isRecord(config)) return undefined;
  const values: Record<string, unknown> = {};
  for (const key of keys) {
    const value = config[key];
    values[key] = isRecord(value) && typeof value.get === 'function' ? value.get() : value;
  }
  return values;
}

/** 解析宿主 volatile 引用中的当前值，也兼容直接传入的原始配置对象。 */
export function currentConfig(config?: unknown): Readonly<PluginConfig> {
  return resolveConfig(readVolatile(config, Object.keys(DEFAULT_CONFIG)) ?? config);
}

type NumberKey =
  | 'observeThresholdTokens'
  | 'reflectThresholdTokens'
  | 'compressMaxTokens'
  | 'rateLimitWaitMs'
  | 'tailMessageCount'
  | 'progressReminderIdleSteps'
  | 'progressReminderIdleToolCalls';

/** 数值键校验参数表：键名 + [是否必须为整数, 下限（含）]。 */
const NUMBER_KEYS: Array<[NumberKey, boolean, number?]> = [
  ['observeThresholdTokens', true],
  ['reflectThresholdTokens', true],
  ['compressMaxTokens', true],
  ['rateLimitWaitMs', true],
  ['tailMessageCount', true],
  ['progressReminderIdleSteps', true, 1],
  ['progressReminderIdleToolCalls', true, 0],
];

/** 校验数值：有限数，integer 时须为整数，且不小于 min；不合法返回 undefined。 */
function resolveNumber(raw: unknown, integer: boolean, min?: number): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  if (integer && !Number.isInteger(raw)) return undefined;
  if (min !== undefined && raw < min) return undefined;
  return raw;
}

/** 归一化原始配置输入：缺省 / null / 空串 / 非对象视为空对象。 */
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

/** 解析 debug 开关：非 boolean 回退 NODE_ENV !== 'production'。 */
function resolveDebug(raw: unknown): boolean {
  return resolveBoolean(raw, process.env.NODE_ENV !== 'production');
}

/** 解析字符串配置值：非空字符串才生效，缺省 / null / 空白串 / 非字符串回退 undefined。 */
function resolveOptionalString(raw: unknown): string | undefined {
  if (typeof raw === 'string' && raw.trim() !== '') return raw;
  return undefined;
}

/** 解析合并配置：未知键忽略、不合法值回退默认值，返回冻结的完整配置。 */
export function resolveConfig(raw?: unknown): Readonly<PluginConfig> {
  const input = normalizeConfigInput(raw);
  const config: PluginConfig = { ...DEFAULT_CONFIG };
  for (const [key, integer, min] of NUMBER_KEYS) {
    const value = resolveNumber(input[key], integer, min);
    if (value !== undefined) config[key] = value;
  }
  config.compressSkipReasoning = resolveBoolean(input.compressSkipReasoning, true);
  config.progressReminderEnabled = resolveBoolean(input.progressReminderEnabled, true);
  config.progressReminderIdleEnabled = resolveBoolean(
    input.progressReminderIdleEnabled,
    DEFAULT_CONFIG.progressReminderIdleEnabled,
  );
  config.debug = resolveDebug(input.debug);
  config.semanticRecallEnabled = resolveBoolean(input.semanticRecallEnabled, true);
  const modelDir = input.modelDir;
  if (typeof modelDir === 'string' && modelDir.trim() !== '') {
    config.modelDir = modelDir;
  }
  config.compressProvider = resolveOptionalString(input.compressProvider);
  config.compressModel = resolveOptionalString(input.compressModel);
  config.compressReasoningEffort = resolveOptionalString(input.compressReasoningEffort);
  return Object.freeze(config);
}
