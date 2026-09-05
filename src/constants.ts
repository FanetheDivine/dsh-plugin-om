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
  '`完整消息`指一条`用户消息`、`系统消息`、`模型输出文本`或`具有result的toolcall`；首条 index 为 0，按会话顺序递增。';

/** 最终 <history> 块内文块首的格式说明注释（XML 注释，完整消息定义 + 条目标签语义）。 */
export const HISTORY_FORMAT_NOTE = `<!-- 完整消息：${COMPLETE_MESSAGE_DEFINITION} <TAG index="N">表示单条完整消息，<TAG start="A" end="B"> 表示连续模块，start/end 是首尾完整消息的 index；<sys type="KIND" index="N"> 表示被压缩的系统消息，块中为空 -->`;

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
