/**
 * 共享类型：宿主类型再导出（type-only，编译期擦除）+ 插件领域类型。
 * 导出官方包宿主类型（Context/Agent/Session 等）、PluginConfig、
 * MessageNode/MessageIndex/CompleteMessage（完整消息索引）与 compaction 载荷扩展。
 * 各 dsh-* 包通过 declare module 增强 Context/Events，使 ctx.tools 等获得宿主一致类型。
 */

import type { Context, EventOptions, Events } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { CompactionId } from '@deepseek-ai/dsh-compaction';
import type { ToolResultPruner } from '@deepseek-ai/dsh-compaction-tool-result-pruner';
import type {
  ContentBlock,
  ImageBlock,
  Message,
  TokenUsage,
  UserMessage,
} from '@deepseek-ai/dsh-llm';
import type { Session, SessionEvent, SessionEventMap } from '@deepseek-ai/dsh-session';
import type { SubagentResult, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent';
import type { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import type { TokenMeter } from '@deepseek-ai/dsh-token-meter';
import type { JsonSchemaNode, ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';

/** 插件配置类型（来自 config.ts）。 */
export type { PluginConfig } from './config.ts';

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * 借用通道（log-only，不进 surface）：dsh-command-feedback 声明的用户反馈
     * 审计事件（{ text: string }），位于宿主 KNOWN_SESSION_EVENT_TYPES 目录内，
     * 历史会话加载不受读取路径的未知类型拒绝影响。本插件以 `om:1:` 前缀 JSON
     * 信封在其 text 字段承载私有事件（编解码见 om-event.ts）。声明与所有者一致，
     * 所有者类型包加入编译依赖后此处移除。
     */
    'feedback/record': { text: string };
  }
}

/** 官方包宿主类型再导出：插件 API 与工具签名统一从这里取型。 */
export type {
  Agent,
  CompactionId,
  ContentBlock,
  Context,
  EventOptions,
  Events,
  ImageBlock,
  JsonSchemaNode,
  Message,
  Session,
  SessionEvent,
  SessionEventMap,
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

/** 一条消息事件（user/assistant/tool-result），带稳定 message_id；消息级索引的节点。 */
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
 * 一条完整消息：摘要日志与 recall 共用的定位单位，分四类——
 * user（用户消息）、sys（系统消息，user_message 中非 user 来源的部分）、
 * assistant（模型输出文本）、toolcall（单个工具调用及其结果）。
 * index 从 0 起、按日志顺序递增、只追加不重排（会话内全局稳定）；
 * 本插件自产的压缩日志消息不占位。
 */
export type CompleteMessage = {
  /** 完整消息序号（0 起，全局稳定）。 */
  index: number;
  /** 类别：user=用户消息；sys=系统消息；assistant=模型输出文本；toolcall=工具调用及其结果。 */
  type: 'user' | 'sys' | 'assistant' | 'toolcall';
  /** 系统消息的 source.kind（仅 sys 类）。 */
  kind?: string;
  /** 关联的消息事件 seq（user/sys/assistant=1 个；toolcall=assistant 消息 + 结果）。 */
  seqs: number[];
  /** 工具调用 id（仅 toolcall 类）。 */
  callId?: string;
};

/**
 * 插件扩展的 compaction/summary 载荷：宿主类型 + shadowedCharCount/attemptCount。
 * 宿主 append 不做 schema 剥离，扩展字段原样持久化；旧会话载荷可能缺失，
 * 客户端读取时按可选处理。宿主类型是 union，无法声明合并，故用交叉类型 + 读取处收窄。
 */
export type CompactionSummaryPayload = SessionEventMap['compaction/summary'] & {
  /** 被压缩内容的字符数（压缩前文本长度合计；UI 标题统计用）。 */
  shadowedCharCount?: number;
  /** 压缩循环的模型请求轮数（旧会话载荷为重试次数，读取时按可选处理）。 */
  attemptCount?: number;
};

/**
 * 插件扩展的 compaction/end 载荷：宿主类型 + diagnosticSessionId（最后一次摘要尝试
 * 无论成功或失败时落盘的诊断子会话 id）。宿主 append 不做 schema 剥离，扩展字段原样持久化；
 * 客户端读取时按可选处理（UI 渲染行为不变）。
 */
export type CompactionEndPayload = SessionEventMap['compaction/end'] & {
  /** 最后一次摘要尝试（成功或失败）落盘的诊断子会话 id（未发出请求或落盘失败时缺失）。 */
  diagnosticSessionId?: string;
};

/**
 * 插件扩展的 compaction/start 载荷：宿主类型 + phase（压缩 pass）。
 * 客户端读取时按可选处理，缺失回落通用压缩中文案。
 */
export type CompactionStartPayload = SessionEventMap['compaction/start'] & {
  /** 压缩 pass（观察/反思；UI 压缩中提示行区分文案）。 */
  phase: 'observe' | 'reflect';
};
