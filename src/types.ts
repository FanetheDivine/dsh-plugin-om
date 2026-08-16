/**
 * 共享类型：全部来自 deepseek-ai 官方包（type-only 导入，编译期擦除，运行时零依赖）。
 *
 * 各 dsh-* 包通过 declare module '@deepseek-ai/cordis' 增强 Context/Events，
 * 使 ctx.tools / ctx.tokenMeter / ctx.sessions 等获得与真实宿主一致的类型；
 * ctx.on / ctx.get 等 mixin 方法由 cordis 自身声明，无需本地补充。
 */

import type { Context, EventOptions, Events } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { CompactionId } from '@deepseek-ai/dsh-compaction';
import type { ToolResultPruner } from '@deepseek-ai/dsh-compaction-tool-result-pruner';
import type { Message, TokenUsage, UserMessage } from '@deepseek-ai/dsh-llm';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import type { SubagentResult, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent';
import type { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import type { TokenMeter } from '@deepseek-ai/dsh-token-meter';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';

/** 插件配置类型（来自 config.ts，供外部 preset 与类型使用者引用）。 */
export type { PluginConfig } from './config.ts';

/**
 * 官方包宿主类型再导出：插件 API 与工具签名统一从这里取型，
 * 避免各模块直接依赖不同版本的 dsh-* 包类型面。
 */
export type {
  Agent,
  CompactionId,
  Context,
  EventOptions,
  Events,
  Message,
  Session,
  SessionEvent,
  SubagentResult,
  SubagentRun,
  SubagentStartRequest,
  SystemPrompt,
  TokenMeter,
  TokenUsage,
  ToolDefinition,
  ToolResultPruner,
  ToolRunContext,
  UserMessage,
};

/**
 * 一条消息事件（user/assistant/tool-result），带稳定 message_id；
 * 供 recall 按 message_id 定位消息序列下标。
 */
export type MessageNode = {
  /** 事件在日志中的 seq。 */
  seq: number;
  /** 消息的稳定 message_id。 */
  id: string;
  /** 事件类型（仅三类消息事件参与消息索引）。 */
  type: 'user/message' | 'assistant/message' | 'tool/result';
};

/** indexMessages 的返回值：按日志顺序的消息序列 + message_id → 序列下标。 */
export type MessageIndex = {
  /** 按日志顺序排列的消息事件。 */
  messages: MessageNode[];
  /** message_id → messages 数组下标。 */
  byId: Map<string, number>;
};

/**
 * 一条完整消息：摘要日志与 recall 共用的定位单位，分三类——
 * user（用户消息）、assistant（AI 文本）、toolcall（单个工具调用及其结果）。
 * index 从 0 起、按日志顺序递增、只追加不重排 → 会话内全局稳定
 * （压缩后旧摘要条目引用的 index 仍然有效）；插件自产消息不占位。
 */
export type CompleteMessage = {
  /** 完整消息序号（0 起，全局稳定）。 */
  index: number;
  /** 类别：user=用户消息；assistant=AI 文本；toolcall=单个工具调用及其结果。 */
  type: 'user' | 'assistant' | 'toolcall';
  /** 关联的消息事件 seq（user/assistant=1 个；toolcall=assistant 消息 + 结果）。 */
  seqs: number[];
  /** 工具调用 id（仅 toolcall 类；关联 tool/result 用）。 */
  callId?: string;
};
