/**
 * om 私有事件写入：经宿主 appendPluginRecord 追加 plugin record。
 * 导出 appendOmEvent。仅服务端使用，读取侧见 om-event.ts。
 */
import { appendPluginRecord } from '@deepseek-ai/dsh-session';
import type { PluginRecordMap } from '@deepseek-ai/dsh-session/types';
import { OM_RECORD_TYPES, type OmEventKind, type OmEventPayloadMap } from './om-event.ts';
import type { Session } from './types.ts';

/** 追加一条 om 私有事件（ignorable，不进 surface），返回事件 seq。 */
export function appendOmEvent<K extends OmEventKind>(
  session: Session,
  kind: K,
  data: OmEventPayloadMap[K],
): number {
  const type = OM_RECORD_TYPES[kind];
  // 泛型 kind 无法与 PluginRecordMap 的键关联收窄，类型名与载荷的对应由 types.ts 的声明担保。
  return appendPluginRecord(session, type, data as PluginRecordMap[typeof type]);
}
