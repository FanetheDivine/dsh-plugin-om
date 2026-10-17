/**
 * om 事件借用通道：插件私有事件以宿主已知类型 feedback/record 持久化。
 * 导出 OM_EVENT_PREFIX / OmEventKind / OmEventPayloadMap / OmEvent /
 * appendOmEvent / readOmEvent / findOmEvents。
 *
 * 背景：持久化读取路径拒绝 KNOWN_SESSION_EVENT_TYPES 目录之外的未知类型
 * （dsh-session-persistence 的 assertEventsSupported），而 Session.append 不提供
 * ignorable 标记的写入途径，插件自定义事件类型会使含该事件的会话无法加载。
 * feedback/record（dsh-command-feedback 声明）是目录内 log-only 审计事件，所有者
 * invariant 声明其无跨事件关系、无运行时不变量、永不进入模型上下文，故选为承载
 * 类型：插件数据以 `om:1:` 前缀 + JSON 信封写入其 text 字段，解码失败按非 om
 * 记录处理（含用户自写的真实反馈记录）。
 */
import type { Session, SessionEvent, TokenUsage } from './types.ts';

/** om 信封 text 前缀：标识该 feedback/record 记录由本插件写入。 */
export const OM_EVENT_PREFIX = 'om:1:';

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

/** 各类别信封载荷（kind 之外的 JSON 字段）。 */
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

/**
 * 解码一条会话事件为 om 私有事件：仅识别 feedback/record 中带 om 信封前缀的
 * text；前缀缺失、JSON 非法、kind 未知或载荷字段缺失时返回 undefined。
 */
export function readOmEvent(event: SessionEvent | undefined | null): OmEvent | undefined {
  if (event === undefined || event === null || event.type !== 'feedback/record') return undefined;
  const text = event.data.text;
  if (typeof text !== 'string' || !text.startsWith(OM_EVENT_PREFIX)) return undefined;
  let envelope: unknown;
  try {
    envelope = JSON.parse(text.slice(OM_EVENT_PREFIX.length));
  } catch {
    return undefined;
  }
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope))
    return undefined;
  const { kind, ...rest } = envelope as Record<string, unknown>;
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

/** 编码一条 om 私有事件为 feedback/record 的 text 信封。 */
function encodeOmEvent<K extends OmEventKind>(kind: K, data: OmEventPayloadMap[K]): string {
  return `${OM_EVENT_PREFIX}${JSON.stringify({ kind, ...data })}`;
}

/** 追加一条 om 私有事件（借用 feedback/record，log-only，不进 surface），返回事件 seq。 */
export function appendOmEvent<K extends OmEventKind>(
  session: Session,
  kind: K,
  data: OmEventPayloadMap[K],
): number {
  return session.append('feedback/record', { text: encodeOmEvent(kind, data) }).seq;
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
