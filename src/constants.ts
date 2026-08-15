/**
 * 共享常量：集中定义插件级魔法字符串与事件名，避免散落各模块。
 */

/** 插件标识：压缩消息 source.plugin 取值与日志前缀。 */
export const PLUGIN_LABEL = 'dsh-plugin-om';

/** 压缩日志标签名：<om-history>...</om-history> 包裹观察/反思日志块。 */
export const HISTORY_TAG = 'om-history';

/** 影子价格认领事件类型：token-meter 据此识别被替换（遮蔽）的表层节点。 */
export const CLAIM_EVENT = 'compaction/prune';
