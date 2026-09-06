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
import type { Session, SessionEvent } from './types.ts';

/** om 信封 text 前缀：标识该 feedback/record 记录由本插件写入。 */
export const OM_EVENT_PREFIX = 'om:1:';

/** om 私有事件类别（信封 kind 字段）。 */
export type OmEventKind =
  /** 功能降级警告（degrade.ts 报告，客户端渲染「功能降级」警告行）。 */
  | 'om/warning'
  /** 观察压缩待定标记（compress.ts 观察触发时追加）。 */
  | 'om/observe-pending'
  /** 观察压缩待定失效标记（压缩执行完成后追加，声明待定可重新触发）。 */
  | 'om/observe-invalidate';

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
};

/** 一条解码后的 om 私有事件：类别、载荷与承载事件在日志中的 seq。 */
export type OmEvent = {
  [K in OmEventKind]: { kind: K; data: OmEventPayloadMap[K]; seq: number };
}[OmEventKind];

/** 校验载荷字段与类别匹配（运行时守卫，保证返回类型的诚实性）。 */
function isValidPayload(kind: OmEventKind, data: Record<string, unknown>): boolean {
  switch (kind) {
    case 'om/warning':
      return typeof data.problem === 'string' && typeof data.message === 'string';
    case 'om/observe-pending':
      return (
        typeof data.triggerMessageIndex === 'number' &&
        Number.isSafeInteger(data.triggerMessageIndex)
      );
    case 'om/observe-invalidate':
      return typeof data.pendingSeq === 'number' && Number.isSafeInteger(data.pendingSeq);
  }
}

/**
 * 解码一条会话事件为 om 私有事件：仅识别 feedback/record 中带 om 信封前缀的
 * text；前缀缺失、JSON 非法、kind 未知或载荷字段缺失时返回 undefined。
 */
export function readOmEvent(event: SessionEvent | undefined | null): OmEvent | undefined {
  if (event === undefined || event === null || event.type !== 'feedback/record') return undefined;
  const text = (event.data as { text?: unknown } | undefined)?.text;
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
  if (typeof kind !== 'string') return undefined;
  const kinds: OmEventKind[] = ['om/warning', 'om/observe-pending', 'om/observe-invalidate'];
  if (!kinds.includes(kind as OmEventKind)) return undefined;
  const omKind = kind as OmEventKind;
  if (!isValidPayload(omKind, rest)) return undefined;
  return { kind: omKind, data: rest, seq: event.seq } as OmEvent;
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
  for (const event of session.events) {
    const om = readOmEvent(event);
    if (om !== undefined && (kind === undefined || om.kind === kind)) result.push(om);
  }
  return result;
}
