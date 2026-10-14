/**
 * om 事件辅助：读写与查找 plugin:dsh-plugin-om:* 自定义会话事件。
 * 导出 OmEventKind / OmEventPayloadMap / OmEvent /
 * appendOmEvent / readOmEvent / findOmEvents。
 */
import type { Session, SessionEvent } from './types.ts';

/** om 私有事件类别。 */
export type OmEventKind =
  /** 功能降级警告（degrade.ts 报告，客户端渲染「功能降级」警告行）。 */
  | 'plugin:dsh-plugin-om:warning'
  /** 观察压缩待定标记（compress.ts 观察触发时追加）。 */
  | 'plugin:dsh-plugin-om:observe-pending'
  /** 观察压缩待定失效标记（压缩执行完成后追加，声明待定可重新触发）。 */
  | 'plugin:dsh-plugin-om:observe-invalidate';

/** 各类别事件载荷。 */
export type OmEventPayloadMap = {
  'plugin:dsh-plugin-om:warning': {
    /** 降级问题标识（会话内去重键，取值见 degrade.ts）。 */
    problem: string;
    /** 面向用户的简短说明。 */
    message: string;
  };
  'plugin:dsh-plugin-om:observe-pending': {
    /** 触发点：追加时的最后一条完整消息 index。 */
    triggerMessageIndex: number;
  };
  'plugin:dsh-plugin-om:observe-invalidate': {
    /** 被失效的 plugin:dsh-plugin-om:observe-pending 事件 seq。 */
    pendingSeq: number;
  };
};

/** 一条解码后的 om 私有事件：类别、载荷与在日志中的 seq。 */
export type OmEvent = {
  [K in OmEventKind]: { kind: K; data: OmEventPayloadMap[K]; seq: number };
}[OmEventKind];

/** 解码一条会话事件为 om 私有事件：仅识别 plugin:dsh-plugin-om:*。 */
export function readOmEvent(event: SessionEvent | undefined | null): OmEvent | undefined {
  if (event === undefined || event === null) return undefined;
  const data = event.data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;

  switch (event.type) {
    case 'plugin:dsh-plugin-om:warning': {
      const { problem, message } = record;
      if (typeof problem !== 'string' || typeof message !== 'string') return undefined;
      return { kind: event.type, data: { problem, message }, seq: event.seq };
    }
    case 'plugin:dsh-plugin-om:observe-pending': {
      const { triggerMessageIndex } = record;
      if (typeof triggerMessageIndex !== 'number' || !Number.isSafeInteger(triggerMessageIndex))
        return undefined;
      return { kind: event.type, data: { triggerMessageIndex }, seq: event.seq };
    }
    case 'plugin:dsh-plugin-om:observe-invalidate': {
      const { pendingSeq } = record;
      if (typeof pendingSeq !== 'number' || !Number.isSafeInteger(pendingSeq)) return undefined;
      return { kind: event.type, data: { pendingSeq }, seq: event.seq };
    }
    default:
      return undefined;
  }
}

/** 追加一条 om 私有事件（log-only，不进 surface），返回事件 seq。 */
export function appendOmEvent<K extends OmEventKind>(
  session: Session,
  kind: K,
  data: OmEventPayloadMap[K],
): number {
  return session.append(kind as unknown as keyof import('./types.ts').SessionEventMap, data).seq;
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
