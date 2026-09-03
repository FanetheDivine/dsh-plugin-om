/**
 * 共享常量：插件级魔法字符串，集中定义避免散落各模块。
 * 导出 PLUGIN_LABEL / HISTORY_TAG / HISTORY_TIP / COMPLETE_MESSAGE_DEFINITION /
 * COMPACT_CHECKPOINT_PLUGIN / COMPACTION_ABORTED_ERROR / isPluginOwnedSource。
 */

/** 插件标识：压缩消息 source.plugin 取值与日志前缀。 */
export const PLUGIN_LABEL = 'dsh-plugin-om';

/** 压缩日志标签名：<history>...</history> 包裹观察/反思日志块。 */
export const HISTORY_TAG = 'history';

/** 压缩日志块开标签的 tip 属性（对 AI 的提醒：本块是历史压缩产物，不要复述）。 */
export const HISTORY_TIP = '当前块是历史消息的压缩产物，不要复述';

/**
 * 「完整消息」定义（提示词 / 工具描述 / 块顶注释共用）。
 * 完整消息是摘要日志与 recall 共用的定位单位；首条 index 为 0，按会话顺序递增、全局稳定。
 */
export const COMPLETE_MESSAGE_DEFINITION =
  '`完整消息`被定义为`用户消息`，`系统消息`，`模型输出文本`和`具有result的toolcall`的集合。首条`完整消息`的index是0，后续的index递增。';

/** 旧日志压缩消息的宿主 checkpoint 标记 plugin 名（历史兼容识别用）。 */
export const COMPACT_CHECKPOINT_PLUGIN = 'compact';

/**
 * 压缩因 signal 中止而放弃时 compaction/end 的 error 标识（服务端写入、客户端过滤）：
 * 中止不是失败，客户端据此隐藏失败行（宿主不变量要求无 summary 的 end 必须带 error）。
 */
export const COMPACTION_ABORTED_ERROR = '压缩已中止（signal aborted）';

/** 判定 user/message 的 source 是否为本插件自产（压缩日志消息；含旧宿主 checkpoint 标记兼容）。这类消息不占完整消息 index。 */
export function isPluginOwnedSource(
  source: { kind?: string; plugin?: string } | undefined,
): boolean {
  if (source?.kind !== 'plugin') return false;
  return source.plugin === PLUGIN_LABEL || source.plugin === COMPACT_CHECKPOINT_PLUGIN;
}
