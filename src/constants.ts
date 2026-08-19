/**
 * 共享常量：集中定义插件级魔法字符串与事件名，避免散落各模块。
 */

/** 插件标识：压缩消息 source.plugin 取值（注入压缩日志的来源标记）与日志前缀。 */
export const PLUGIN_LABEL = 'dsh-plugin-om';

/** 压缩日志标签名：<history>...</history> 包裹观察/反思日志块（输入与输出均为合法 history 块）。 */
export const HISTORY_TAG = 'history';

/** 压缩日志块开标签上的 tip 属性（对 AI 的提醒：本块是历史压缩产物，不要复述）。 */
export const HISTORY_TIP = '当前块是历史消息的压缩产物，不要复述';

/**
 * 「完整消息」定义（提示词 / recall 工具描述 / 块顶注释共用同一字符串）。
 * 完整消息是摘要日志与 recall 共用的定位单位；首条 index 为 0，按会话顺序递增、全局稳定。
 */
export const COMPLETE_MESSAGE_DEFINITION =
  '`用户消息`，`模型输出文本`和`具有result的toolcall`被视作`完整消息`。首条`完整消息`的index是0，后续的index递增。';

/** 旧日志压缩消息的宿主 checkpoint 标记 plugin 名（dsh-compaction-basic 的 COMPACT_CHECKPOINT_MARKER.plugin；历史兼容识别用）。 */
export const COMPACT_CHECKPOINT_PLUGIN = 'compact';
