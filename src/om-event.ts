/**
 * om 私有事件的读取通道：插件私有事件以宿主实验性 plugin record 持久化。
 * 导出 OmEventKind / OmEventPayloadMap / OmEvent / OM_RECORD_TYPES /
 * readOmEvent / findOmEvents；写入见 om-event-append.ts。
 *
 * plugin record 是带 ignorable 标记、类型名以 `plugin:` 开头的日志事件：不进
 * surface，宿主读取路径遇到不认识的类型时保留并跳过，会话仍可加载。本文件不引入
 * 宿主运行时模块，客户端 bundle 可直接使用。
 */
import type { Session, SessionEvent, TokenUsage } from './types.ts';

/** om 私有事件类别（信封 kind 字段）。 */
export type OmEventKind =
  /** 功能降级警告（degrade.ts 报告，客户端渲染「功能降级」警告行）。 */
  | 'om/warning'
  /** 观察压缩待定标记（compress.ts 观察触发时追加）。 */
  | 'om/observe-pending'
  /** 观察压缩待定失效标记（压缩执行完成后追加，声明待定可重新触发）。 */
  | 'om/observe-invalidate'
  /** 观察预压缩结果（后台压缩任务成功时写入，注入前崩溃可恢复：按 pendingSeq 匹配活跃标记采纳）。 */
  | 'om/observe-summary';

/** 各类别对应的 plugin record 类型名（grammar：`plugin:` 后以 `/` 分段）。 */
export const OM_RECORD_TYPES = {
  'om/warning': 'plugin:dsh-plugin-om/warning',
  'om/observe-pending': 'plugin:dsh-plugin-om/observe-pending',
  'om/observe-invalidate': 'plugin:dsh-plugin-om/observe-invalidate',
  'om/observe-summary': 'plugin:dsh-plugin-om/observe-summary',
} as const satisfies Record<OmEventKind, `plugin:${string}`>;

/** 各类别记录载荷。 */
export type OmEventPayloadMap = {
  'om/warning': {
    /** 降级问题标识（会话内去重键，取值见 degrade.ts）。 */
    problem: string;
    /** 面向用户的简短说明。 */
    message: string;
  };
  'om/observe-pending': {
    /** 触发点：追加时的最后一条完整消息 index。 */
    triggerMessageIndex: number;
  };
  'om/observe-invalidate': {
    /** 被失效的 om/observe-pending 事件 seq。 */
    pendingSeq: number;
  };
  'om/observe-summary': {
    /** 所属 om/observe-pending 事件 seq（与活跃标记匹配方可采纳）。 */
    pendingSeq: number;
    /** 最终 <history> 块文本（压缩结果）。 */
    report: string;
    /** 压缩实际使用的路由 provider。 */
    provider: string;
    /** 压缩实际使用的路由 model。 */
    model: string;
    /** 压缩循环开始时间（epoch 毫秒）。 */
    startedAt: number;
    /** 压缩循环结束时间（epoch 毫秒）。 */
    completedAt: number;
    /** 压缩循环总耗时（毫秒）。 */
    durationMs: number;
    /** 压缩会话记录子会话 id（落盘失败时缺省）。 */
    recordSessionId?: string;
    /** 全部轮次 token usage 合计（无 usage 数据时缺省）。 */
    usage?: TokenUsage;
    /** 压缩实际使用的思考等级 id（用模型默认时缺省；品牌类型由使用处校验担保）。 */
    reasoningEffort?: string;
  };
};

/** 一条解码后的 om 私有事件：类别、载荷与承载事件在日志中的 seq。 */
export type OmEvent = {
  [K in OmEventKind]: { kind: K; data: OmEventPayloadMap[K]; seq: number };
}[OmEventKind];

/** plugin record 类型名到 om 类别的反查表。 */
const KIND_BY_RECORD_TYPE: ReadonlyMap<string, OmEventKind> = new Map(
  (Object.entries(OM_RECORD_TYPES) as Array<[OmEventKind, string]>).map(([kind, type]) => [
    type,
    kind,
  ]),
);

/**
 * 解码一条会话事件为 om 私有事件：仅识别带 ignorable 标记且类型名属于本插件的
 * plugin record；类型不符、载荷非对象或字段缺失时返回 undefined。
 */
export function readOmEvent(event: SessionEvent | undefined | null): OmEvent | undefined {
  if (event === undefined || event === null || event.ignorable !== true) return undefined;
  const kind = KIND_BY_RECORD_TYPE.get(event.type);
  if (kind === undefined) return undefined;
  const payload: unknown = event.data;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const rest = payload as Record<string, unknown>;
  switch (kind) {
    case 'om/warning': {
      const { problem, message } = rest;
      if (typeof problem !== 'string' || typeof message !== 'string') return undefined;
      return { kind, data: { problem, message }, seq: event.seq };
    }
    case 'om/observe-pending': {
      const { triggerMessageIndex } = rest;
      if (typeof triggerMessageIndex !== 'number' || !Number.isSafeInteger(triggerMessageIndex))
        return undefined;
      return { kind, data: { triggerMessageIndex }, seq: event.seq };
    }
    case 'om/observe-invalidate': {
      const { pendingSeq } = rest;
      if (typeof pendingSeq !== 'number' || !Number.isSafeInteger(pendingSeq)) return undefined;
      return { kind, data: { pendingSeq }, seq: event.seq };
    }
    case 'om/observe-summary': {
      const {
        pendingSeq,
        report,
        provider,
        model,
        startedAt,
        completedAt,
        durationMs,
        recordSessionId,
        usage,
        reasoningEffort,
      } = rest;
      if (typeof pendingSeq !== 'number' || !Number.isSafeInteger(pendingSeq)) return undefined;
      if (typeof report !== 'string') return undefined;
      if (typeof provider !== 'string' || typeof model !== 'string') return undefined;
      if (!isFiniteNumber(startedAt) || !isFiniteNumber(completedAt) || !isFiniteNumber(durationMs))
        return undefined;
      if (recordSessionId !== undefined && typeof recordSessionId !== 'string') return undefined;
      if (reasoningEffort !== undefined && typeof reasoningEffort !== 'string') return undefined;
      const parsedUsage = readTokenUsage(usage);
      if (parsedUsage === null) return undefined;
      const data: OmEventPayloadMap['om/observe-summary'] = {
        pendingSeq,
        report,
        provider,
        model,
        startedAt,
        completedAt,
        durationMs,
        ...(recordSessionId === undefined ? {} : { recordSessionId }),
        ...(parsedUsage === undefined ? {} : { usage: parsedUsage }),
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      };
      return { kind, data, seq: event.seq };
    }
    default:
      return undefined;
  }
}

/** 校验有限数值字段（时间戳/耗时）。 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 校验可选 token usage 字段：缺省返回 undefined，非法返回 null，合法返回仅含已知数值字段的对象。 */
function readTokenUsage(value: unknown): TokenUsage | undefined | null {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const usage = value as Record<string, unknown>;
  const { inputTokens, outputTokens } = usage;
  if (!isFiniteNumber(inputTokens) || !isFiniteNumber(outputTokens)) return null;
  const result: TokenUsage = { inputTokens, outputTokens };
  for (const key of [
    'totalTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'reasoningTokens',
  ] as const) {
    const field = usage[key];
    if (field === undefined) continue;
    if (!isFiniteNumber(field)) return null;
    result[key] = field;
  }
  return result;
}

/** 读取日志中全部 om 私有事件（按日志顺序）。 */
export function findOmEvents(session: Session): OmEvent[];
/** 读取日志中指定类别的 om 私有事件（按日志顺序，载荷类型按类别收窄）。 */
export function findOmEvents<K extends OmEventKind>(
  session: Session,
  kind: K,
): Array<{ kind: K; data: OmEventPayloadMap[K]; seq: number }>;
export function findOmEvents(session: Session, kind?: OmEventKind): OmEvent[] {
  const result: OmEvent[] = [];
  for (const event of session.snapshotEvents()) {
    const om = readOmEvent(event);
    if (om !== undefined && (kind === undefined || om.kind === kind)) result.push(om);
  }
  return result;
}
