/**
 * 共享常量：插件级魔法字符串，集中定义避免散落各模块。
 * 导出 PLUGIN_LABEL / PLUGIN_SOURCE_KIND / OmMessageSource / omSource /
 * HISTORY_TAG / HISTORY_TIP / COMPLETE_MESSAGE_DEFINITION /
 * historyFormatNote / SKILL_TOOL_NAME / ASK_USER_QUESTION_TOOL_NAME /
 * COMPACT_CHECKPOINT_PLUGIN / COMPACTION_ABORTED_ERROR / isPluginOwnedSource。
 */
import type { CompactionId } from '@deepseek-ai/dsh-compaction';

/** 插件标识：日志前缀与历史日志的 source.plugin 取值。 */
export const PLUGIN_LABEL = 'dsh-plugin-om';

/**
 * 插件自产消息的 producer-owned source kind（format v4 要求消息 source 为生产者自有
 * kind，与宿主 v3→v4 迁移对本插件旧日志的产出一致；types.ts 把它声明进宿主
 * MessageSourceMap，使 UserMessage.source 原生接受该形态）。
 */
export const PLUGIN_SOURCE_KIND = 'plugin:dsh-plugin-om';

/** 插件自产消息的 source（compactionId 仅 <history> 替换检查点消息携带）。 */
export type OmMessageSource = {
  readonly kind: typeof PLUGIN_SOURCE_KIND;
  /** 关联的 compaction 生命周期 id（仅替换检查点消息）。 */
  readonly compactionId?: CompactionId;
};

/** 构造插件自产消息的 source（compactionId 仅替换检查点消息传入）。 */
export function omSource(compactionId?: CompactionId): OmMessageSource {
  return { kind: PLUGIN_SOURCE_KIND, ...(compactionId === undefined ? {} : { compactionId }) };
}

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

/** 块顶格式说明注释中按块内条目动态追加的分段开关。 */
export type HistoryNoteSections = {
  /** 块内存在 user 条目时追加 <user_message> 说明。 */
  user?: boolean;
  /** 块内存在 sys 条目时追加 <sys> 说明。 */
  sys?: boolean;
  /** 块内存在未压缩 skill 条目时追加 <skill_content> 说明。 */
  skill?: boolean;
  /** 块内存在 ask_user_question 条目时追加 <ask-user-question> 说明。 */
  askUserQuestion?: boolean;
};

/**
 * 最终 <history> 块内文块首的格式说明注释（XML 注释）。通用部分（完整消息定义 +
 * 条目标签语义 + CDATA 约定 + toolcall 结构）始终保留；<user_message> / <sys> /
 * <skill_content> / <ask-user-question> 的条目说明仅在块内存在对应条目时追加。
 */
export function historyFormatNote(sections: HistoryNoteSections = {}): string {
  const parts = [
    COMPLETE_MESSAGE_DEFINITION,
    '<TAG index="N">表示单条完整消息，<TAG start="A" end="B"> 表示多条连续消息，start/end 是首尾完整消息的 index；消息块的内容是用CDATA包裹的纯文本',
    '<assistant type="toolcall" tool-name="T" callId="C" index="N"> 表示工具调用，内含 <tool-args> 与 <tool-result> 两个CDATA子元素（调用参数与工具返回内容）',
  ];
  if (sections.user) parts.push('<user_message index="N"> 表示用户消息原文');
  if (sections.sys) parts.push('<sys type="KIND" index="N"> 表示被压缩的系统消息，块中为空');
  if (sections.skill) parts.push('<skill_content name="S" index="N"> 表示未压缩的原始 skill');
  if (sections.askUserQuestion)
    parts.push(
      '<ask-user-question index="N"> 表示向用户提问，CDATA 内为逐题成对的 q:（提问）与 a:（用户回答）行，未作答的题记为 a:(未回答)',
    );
  return `<!-- ${parts.join('；')} -->`;
}

/** skill 工具名：toolcall 条目的工具名为该值时视为 skill 加载，<history> 块中以 <skill_content> 元素呈现。 */
export const SKILL_TOOL_NAME = 'skill';

/**
 * ask_user_question 工具名：toolcall 条目的工具名为该值时视为向用户的提问，
 * <history> 块中以 <ask-user-question> 元素呈现，压缩时与 skill 一样要求二次确认。
 */
export const ASK_USER_QUESTION_TOOL_NAME = 'ask_user_question';

/** 宿主压缩 checkpoint 消息的 source 标记（0.1.7 起为 kind 'compact-checkpoint'；旧日志为 plugin 'compact'）。 */
export const COMPACT_CHECKPOINT_PLUGIN = 'compact';

/** 宿主压缩 checkpoint 消息的 source kind。 */
export const COMPACT_CHECKPOINT_KIND = 'compact-checkpoint';

/**
 * 压缩因 signal 中止而放弃时 compaction/end 的 error 标识（服务端写入、客户端过滤）：
 * 中止不是失败，客户端据此隐藏失败行（宿主不变量要求无 summary 的 end 必须带 error）。
 */
export const COMPACTION_ABORTED_ERROR = '压缩已中止（signal aborted）';

/**
 * 判定 user/message 的 source 是否为本插件自产或宿主压缩 checkpoint（压缩日志消息与
 * 宿主压缩替换消息）。这类消息不占完整消息 index。宿主迁移前的 v3 信封形态
 * （kind 'plugin' + plugin 字段）仅作读取防御保留。
 */
export function isPluginOwnedSource(
  source: { kind?: string; plugin?: string } | undefined,
): boolean {
  if (source?.kind === COMPACT_CHECKPOINT_KIND) return true;
  if (source?.kind === PLUGIN_SOURCE_KIND) return true;
  if (source?.kind !== 'plugin') return false;
  return source.plugin === PLUGIN_LABEL || source.plugin === COMPACT_CHECKPOINT_PLUGIN;
}
