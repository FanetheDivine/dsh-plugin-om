/**
 * 共享常量：集中定义插件级魔法字符串与事件名，避免散落各模块。
 */

/** 插件标识：压缩消息 source.plugin 取值与日志前缀。 */
export const PLUGIN_LABEL = 'dsh-plugin-om';

/** 压缩日志标签名：<om-history>...</om-history> 包裹观察/反思日志块。 */
export const HISTORY_TAG = 'om-history';

/** 宿主压缩 checkpoint 标记的 plugin 名（dsh-compaction-basic 的 COMPACT_CHECKPOINT_MARKER.plugin）。 */
export const COMPACT_CHECKPOINT_PLUGIN = 'compact';

/** recall 工具启用开关环境变量名（值 === 'false' 时禁用，其余取值启用；缺省启用）。 */
export const RECALL_ENABLED_ENV = 'OM_RECALL_ENABLED';

/** recall-semantic 工具启用开关环境变量名（值 === 'false' 时禁用，其余取值启用；缺省启用）。 */
export const SEMANTIC_RECALL_ENABLED_ENV = 'OM_SEMANTIC_RECALL_ENABLED';
