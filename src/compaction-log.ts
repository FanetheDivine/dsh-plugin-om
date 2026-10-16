/**
 * 压缩会话记录落盘：把工具压缩循环的完整会话消息组以 seed 事件重建为一个 one-shot
 * 诊断子会话（header origin 'subagent' + 首事件 subagent/descriptor），在父会话登记
 * subagent/catalog，使其出现在宿主子智能体列表并随父会话日志导出。成功与失败均落盘
 * （label 区分，换模型重压缩另带目标模型标记）。导出 recordCompressionSession / compressionRecordLabel /
 * COMPACTION_LOG_PROVIDER。
 *
 * - 子会话经 ctx.sessions.create(seed) 构造：每个事件携带从循环统计重建的 time
 *   （turn 边界取循环起止、第 k 个 assistant 取第 k 轮起止、工具调用与结果与其
 *   assistant 同刻），并把逐轮 usage 附加到 assistant/message，使宿主原生 UI 直接
 *   渲染 turn 时长、逐轮 LLM 延迟、消息时钟与 Turn usage 面板
 * - 压缩系统提示词落盘为 system/message（随任务指令 step 开启时先行落盘，宿主 UI
 *   呈现「系统提示词」）；任务指令 source 改写为用户来源（宿主呈现为用户消息），
 *   轮间提醒保持插件来源
 * - 循环消息组按宿主 turn/step 生命周期重建；未执行的工具调用补齐失败结果
 * - 失败时的子会话 id 由调用方写入主会话日志与 compaction/end 载荷（compress.ts /
 *   index.ts）
 * - 落盘自身绝不抛错：任何失败仅 logger.warn 并返回 undefined，不影响压缩流程
 */

import type {
  AssistantMessage,
  Message,
  ToolCallBlock,
  ToolResultMessage,
  UserMessage,
} from '@deepseek-ai/dsh-llm';
import {
  createAssistantMessage,
  createSystemMessage,
  createToolResultMessage,
} from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-persistence';
import { SUBAGENT_DESCRIPTOR_VERSION } from '@deepseek-ai/dsh-subagent';
import type { CompressionStats } from './compress-loop.ts';
import { formatCompactCount } from './format.ts';
import { makeLogger } from './logger.ts';
import type { Context, Session, SessionEvent, SessionEventMap } from './types.ts';
import { type RoutedTarget, uuid } from './utils.ts';

/** 诊断子会话的 descriptor provider（宿主子代理列表识别用）。 */
export const COMPACTION_LOG_PROVIDER = 'om-compaction-log';

/** 压缩 pass 的中文标签（会话记录 label 用；未知阶段回落「压缩」）。 */
function phaseLabel(phase: 'observe' | 'reflect' | undefined): string {
  if (phase === 'observe') return '观察';
  if (phase === 'reflect') return '反思';
  return '压缩';
}

/**
 * 压缩会话记录 label：成功为会话记录、失败为失败日志，均含压缩阶段与轮数；
 * 换模型重压缩传入 retryTarget，label 末尾追加「重压缩 provider/model」以区分。
 */
export function compressionRecordLabel(
  phase: 'observe' | 'reflect' | undefined,
  rounds: number,
  success: boolean,
  retryTarget?: RoutedTarget,
): string {
  const retry =
    retryTarget === undefined ? '' : ` · 重压缩 ${retryTarget.provider}/${retryTarget.model}`;
  return `OM 压缩${success ? '会话记录' : '失败日志'}（${phaseLabel(phase)} · ${rounds} 轮${retry}）`;
}

/** 日志尾部的模型信息：展示文本与归因的 provider/model。 */
export type CompressionInfo = {
  text: string;
  provider: string;
  model: string;
};

/** 生成模型信息：压缩模型、思考等级、原始消息与压缩产物的字符数（k 单位）。 */
export function compressionInfo(info: {
  target: RoutedTarget;
  /** 思考等级；缺省为模型默认。 */
  reasoningEffort?: string;
  /** 原始消息字符数。 */
  originalChars: number;
  /** 压缩产物字符数；失败时缺省。 */
  resultChars?: number;
}): CompressionInfo {
  const effort = info.reasoningEffort ?? '默认思考等级';
  const result =
    info.resultChars === undefined
      ? '无（压缩失败）'
      : `${formatCompactCount(info.resultChars)} 字符`;
  return {
    text: `压缩使用模型 ${info.target.provider}/${info.target.model}（${effort}），原始消息 ${formatCompactCount(info.originalChars)} 字符，压缩产物 ${result}`,
    provider: info.target.provider,
    model: info.target.model,
  };
}

/**
 * 构造一个 seed 事件信封：seq 由调用方按顺序传入，surface 事件附 surfaceOp:'append'。
 * 宿主 seed 边界校验信封字段（type/seq/time/data/surfaceOp）与消息形状，并原样保留
 * time（append 路径会强制改写为 Date.now()），故诊断记录经 seed 重建时间线。信封为
 * 判别联合，泛型构造需一次断言（与 tests/helpers.ts 同法）。
 */
function seedEvent<K extends keyof SessionEventMap>(
  type: K,
  seq: number,
  time: number,
  data: SessionEventMap[K],
  surfaceOp?: 'append',
): SessionEvent {
  return {
    type,
    seq,
    time,
    data,
    ...(surfaceOp === undefined ? {} : { surfaceOp }),
  } as unknown as SessionEvent;
}

/**
 * 重建压缩循环的 seed 事件时间线：descriptor + turn/step 生命周期 + 逐消息事件。每个
 * 事件携带从循环统计推导的 time——turn 边界取循环起止、第 k 个 assistant 取第 k 轮
 * 起止（step/start = startedAt、assistant/message = startedAt + durationMs）、工具调用
 * 与结果与其 assistant 同刻（内存工具瞬时）——并把逐轮 usage 附加到 assistant/message。
 * 时间全程单调不减；轮次数组短于 assistant 数时（流错误注入的部分 assistant）回落上一
 * 轮结束时刻与循环结束时刻。
 */
function buildCompressionSeed(
  messages: readonly Message[],
  stats: CompressionStats,
  label: string,
  info?: CompressionInfo,
  system?: string,
): SessionEvent[] {
  const seed: SessionEvent[] = [];
  const push = <K extends keyof SessionEventMap>(
    type: K,
    time: number,
    data: SessionEventMap[K],
    surfaceOp?: 'append',
  ): void => {
    seed.push(seedEvent(type, seed.length, time, data, surfaceOp));
  };
  // 单调时间游标：任何重建时刻都不早于已落盘的最后时刻
  let cursor = stats.startedAt;
  const at = (time: number): number => {
    cursor = Math.max(cursor, time);
    return cursor;
  };
  // 已执行工具调用的 id 集合（据此区分原样落盘与 TOOL_NOT_STARTED 补齐）
  const executed = new Set(
    messages
      .filter((message): message is ToolResultMessage => message.role === 'tool')
      .map((message) => message.toolCallId),
  );

  push('subagent/descriptor', at(stats.startedAt), {
    version: SUBAGENT_DESCRIPTOR_VERSION,
    mode: 'one-shot',
    provider: COMPACTION_LOG_PROVIDER,
    label,
  });
  push('turn/start', at(stats.startedAt), { turn: 1 });

  let step = 1;
  let assistantIndex = 0;
  let stepTime = stats.startedAt; // 当前开放 step 的 assistant 完成时刻
  let stepOpen = false;
  let pending: ToolCallBlock[] = [];

  const closeStep = (): void => {
    if (!stepOpen) return;
    for (const call of pending) {
      if (executed.has(call.id)) continue;
      const repair = createToolResultMessage({
        callId: call.id,
        content: [{ type: 'text', text: '压缩循环未执行此工具调用' }],
        isError: true,
      });
      push(
        'tool/result',
        at(stepTime),
        {
          turn: 1,
          step,
          message: {
            ...repair,
            id: `forked-tool-result-${call.id}-${uuid()}` as ToolResultMessage['id'],
          },
          error: { name: 'ToolNotStartedError', code: 'TOOL_NOT_STARTED' },
        },
        'append',
      );
    }
    push('step/end', at(stepTime), { turn: 1, step });
    pending = [];
    stepOpen = false;
  };

  for (const message of messages) {
    if (message.role === 'assistant') {
      closeStep();
      step += 1;
      const round = stats.rounds[assistantIndex];
      assistantIndex += 1;
      const startAt = round?.startedAt ?? stepTime;
      const completedAt =
        round === undefined ? stats.completedAt : round.startedAt + round.durationMs;
      push('step/start', at(startAt), { turn: 1, step });
      stepOpen = true;
      const assistant = message as AssistantMessage;
      const assistantTime = at(completedAt);
      push(
        'assistant/message',
        assistantTime,
        {
          turn: 1,
          step,
          message: assistant,
          stream: [],
          ...(round?.usage === undefined ? {} : { usage: round.usage }),
        },
        'append',
      );
      stepTime = assistantTime;
      pending = assistant.content.filter(
        (block): block is ToolCallBlock => block.type === 'tool-call',
      );
      for (const call of pending) {
        if (!executed.has(call.id)) continue;
        push('tool/call', at(stepTime), {
          turn: 1,
          step,
          callId: call.id,
          name: call.name,
          arguments: call.arguments,
        });
      }
    } else if (message.role === 'tool') {
      push(
        'tool/result',
        at(stepTime),
        { turn: 1, step, message: message as ToolResultMessage },
        'append',
      );
    } else if (!stepOpen) {
      const user = message as UserMessage;
      // 任务指令所属 step 与宿主时序一致（step/start → system/message → user/message），
      // 压缩系统提示词随该 step 落盘（宿主 UI 呈现「系统提示词」），指令 source 改写为
      // 用户来源（宿主呈现为用户消息）
      push('step/start', at(stats.startedAt), { turn: 1, step });
      stepOpen = true;
      if (system !== undefined && system !== '') {
        push(
          'system/message',
          at(stats.startedAt),
          { turn: 1, step, message: createSystemMessage(system) },
          'append',
        );
      }
      push(
        'user/message',
        at(stats.startedAt),
        { ...user, source: { kind: 'user' as const } },
        'append',
      );
    } else {
      const user = message as UserMessage;
      // 轮间提醒（开放 step）：与当前时刻同刻，保持插件来源（宿主呈现为上下文注入）
      push('user/message', at(stepTime), user, 'append');
    }
  }
  closeStep();
  if (info !== undefined) {
    // 模型信息：以模型来源的 assistant 文本追加在时间线尾部（插件来源的消息宿主不展示）
    step += 1;
    push('step/start', at(stats.completedAt), { turn: 1, step });
    push(
      'assistant/message',
      at(stats.completedAt),
      {
        turn: 1,
        step,
        message: createAssistantMessage({
          content: [{ type: 'text', text: info.text }],
          source: { provider: info.provider, model: info.model },
        }),
        stream: [],
      },
      'append',
    );
    push('step/end', at(stats.completedAt), { turn: 1, step });
  }
  push('turn/end', at(stats.completedAt), { turn: 1, reason: { kind: 'completed' } });
  return seed;
}

/**
 * 把一次压缩工具循环的完整会话消息组落盘为子会话：以重建时间线的 seed 事件经
 * ctx.sessions.create 构造子会话（header origin 'subagent'、parentSession 指向主会话、
 * delegationDepth = 父 + 1、cwd 继承主会话；首事件 one-shot descriptor，provider
 * om-compaction-log，label 含压缩阶段与轮数；info 存在时尾部追加一条模型文本），flush 持久化，在父会话登记
 * subagent/catalog，返回子会话 id。成功与失败均调用；落盘自身绝不抛错，任何失败仅
 * logger.warn 并返回 undefined。
 */
export async function recordCompressionSession(
  ctx: Context,
  parentSession: Session,
  options: {
    /** 压缩 pass（记录 label 用）。 */
    phase: 'observe' | 'reflect' | undefined;
    /** 循环全部消息（user 指令/提醒、assistant 含 tool-call、tool-result，原样）。 */
    messages: readonly Message[];
    /** 循环统计（label 轮数、时间线重建与逐轮 usage 来源）。 */
    stats: CompressionStats;
    /** 循环实际发送的压缩系统提示词；存在且非空时落盘为 system/message（表层节点 0）。 */
    system?: string;
    /** 是否成功完成（label 区分会话记录/失败日志）。 */
    success: boolean;
    /** 插件 debug 开关（落盘失败的 warn 是否带步骤细节）。 */
    debug: boolean;
    /** 换模型重压缩的目标模型（label 区分用）；常规压缩缺省。 */
    retryTarget?: RoutedTarget;
    /** 模型信息（compressionInfo），追加为尾部模型文本；缺省不写。 */
    info?: CompressionInfo;
  },
): Promise<string | undefined> {
  const logger = makeLogger(ctx, options.debug);
  try {
    const header = parentSession.header;
    const label = compressionRecordLabel(
      options.phase,
      options.stats.rounds.length,
      options.success,
      options.retryTarget,
    );
    const seed = buildCompressionSeed(
      options.messages,
      options.stats,
      label,
      options.info,
      options.system,
    );
    const sessions = ctx.get('sessions');
    if (sessions === undefined) {
      logger.warn('sessions 服务未挂载，跳过压缩会话记录落盘');
      return undefined;
    }
    const child = sessions.create(SessionId(`om-compaction-log-${uuid()}`), {
      seed,
      meta: {
        ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
        parentSession: parentSession.id,
        origin: 'subagent',
        delegationDepth: (header.delegationDepth ?? 0) + 1,
      },
    });
    const persistence = ctx.get('sessionPersistence');
    if (persistence === undefined) throw new Error('宿主未提供 sessionPersistence 服务');
    const write = await persistence.create(child.header);
    try {
      await write.append(child.snapshotEvents());
      await write.flush();
    } finally {
      await write.close();
    }
    parentSession.append('subagent/catalog', {
      version: 0,
      childId: child.id,
      childCreatedAt: child.header.createdAt,
      mode: 'one-shot',
      label,
    });
    await sessions.flush(parentSession);
    return child.id;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`压缩会话记录子会话落盘失败: ${message}`);
    return undefined;
  }
}
