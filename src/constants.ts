/**
 * 共享常量：集中定义插件级魔法字符串与事件名，避免散落各模块。
 */

/** 插件标识：压缩消息 source.plugin 取值与日志前缀。 */
export const PLUGIN_LABEL = 'dsh-plugin-om';

/** 压缩日志标签名：<om-history>...</om-history> 包裹观察/反思日志块。 */
export const HISTORY_TAG = 'om-history';

/** 压缩日志块开标签上的 tip 属性（对 AI 的提醒：本块是历史压缩产物，不要复述）。 */
export const HISTORY_TIP = '当前块是历史消息的压缩产物，不要复述';

/** 宿主压缩 checkpoint 标记的 plugin 名（dsh-compaction-basic 的 COMPACT_CHECKPOINT_MARKER.plugin）。 */
export const COMPACT_CHECKPOINT_PLUGIN = 'compact';
