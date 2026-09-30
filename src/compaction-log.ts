/**
 * 压缩会话记录落盘：把工具压缩循环的完整会话消息组原样落盘为一个 one-shot 诊断
 * 子会话（header origin 'subagent' + 首事件 subagent/descriptor），在父会话登记
 * subagent/catalog，使其出现在宿主子智能体列表并随父会话日志导出。成功与失败
 * 均落盘（label 区分）。导出 recordCompressionSession / compressionRecordLabel /
 * formatCompressionStats / COMPACTION_LOG_PROVIDER。
 *
 * - 循环消息组按宿主 turn/step 生命周期追加；未执行的工具调用补齐失败结果；
 *   末尾追加一条插件来源的统计消息（formatCompressionStats：起止时间、总耗时、
 *   逐轮请求耗时与 usage、usage 合计）
 * - 失败时的子会话 id 由调用方写入主会话日志与 compaction/end 载荷（compress.ts /
 *   index.ts）
 * - 落盘自身绝不抛错：任何失败仅 logger.warn 并返回 undefined，不影响压缩流程
 */

import type {
  AssistantMessage,
  Message,
  TokenUsage,
  ToolCallBlock,
  ToolResultMessage,
  UserMessage,
} from '@deepseek-ai/dsh-llm';
import { createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-persistence';
import { SUBAGENT_DESCRIPTOR_VERSION } from '@deepseek-ai/dsh-subagent';
import type { CompressionRoundStat, CompressionStats } from './compress-loop.ts';
import { omSource } from './constants.ts';
import { makeLogger } from './logger.ts';
import type { Context, Session } from './types.ts';
import { type RoutedTarget, uuid } from './utils.ts';

/** 诊断子会话的 descriptor provider（宿主子代理列表识别用）。 */
export const COMPACTION_LOG_PROVIDER = 'om-compaction-log';

/** 压缩 pass 的中文标签（会话记录 label 用；未知阶段回落「压缩」）。 */
function phaseLabel(phase: 'observe' | 'reflect' | undefined): string {
  if (phase === 'observe') return '观察';
  if (phase === 'reflect') return '反思';
  return '压缩';
}

/** 压缩会话记录 label：成功为会话记录、失败为失败日志，均含压缩阶段与轮数。 */
export function compressionRecordLabel(
  phase: 'observe' | 'reflect' | undefined,
  rounds: number,
  success: boolean,
): string {
  return `OM 压缩${success ? '会话记录' : '失败日志'}（${phaseLabel(phase)} · ${rounds} 轮）`;
}

/** usage 各桶文案（缺失桶显示 -）。 */
function usageLine(usage: TokenUsage): string {
  const field = (value?: number): string => (value === undefined ? '-' : String(value));
  return `input ${field(usage.inputTokens)} / output ${field(usage.outputTokens)} / cacheRead ${field(usage.cacheReadTokens)} / cacheWrite ${field(usage.cacheWriteTokens)} / reasoning ${field(usage.reasoningTokens)} tokens`;
}

/** 汇总逐轮 usage（各桶任一轮存在即求和保留；全部轮次无 usage 时返回 undefined）。 */
function sumRoundUsage(rounds: readonly CompressionRoundStat[]): TokenUsage | undefined {
  let total: TokenUsage | undefined;
  for (const round of rounds) {
    if (round.usage === undefined) continue;
    if (total === undefined) {
      total = { ...round.usage };
      continue;
    }
    const sum = (a?: number, b?: number): number | undefined =>
      a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
    const merged: TokenUsage = {
      inputTokens: (total.inputTokens ?? 0) + (round.usage.inputTokens ?? 0),
      outputTokens: (total.outputTokens ?? 0) + (round.usage.outputTokens ?? 0),
    };
    const cacheRead = sum(total.cacheReadTokens, round.usage.cacheReadTokens);
    const cacheWrite = sum(total.cacheWriteTokens, round.usage.cacheWriteTokens);
    const reasoning = sum(total.reasoningTokens, round.usage.reasoningTokens);
    if (cacheRead !== undefined) merged.cacheReadTokens = cacheRead;
    if (cacheWrite !== undefined) merged.cacheWriteTokens = cacheWrite;
    if (reasoning !== undefined) merged.reasoningTokens = reasoning;
    total = merged;
  }
  return total;
}

/**
 * 格式化压缩循环统计为统计消息文本：起止时间（ISO）、总耗时、逐轮请求耗时与
 * usage、usage 合计。随会话记录在子会话末尾落盘。
 */
export function formatCompressionStats(
  phase: 'observe' | 'reflect' | undefined,
  success: boolean,
  stats: CompressionStats,
): string {
  const lines: string[] = [
    '【压缩统计】',
    `阶段：${phaseLabel(phase)}｜结果：${success ? '成功' : '失败'}`,
    `开始：${new Date(stats.startedAt).toISOString()}`,
    `结束：${new Date(stats.completedAt).toISOString()}`,
    `总耗时：${stats.durationMs} ms`,
    `请求轮数：${stats.rounds.length}`,
  ];
  if (stats.rounds.length > 0) {
    lines.push('逐轮：');
    for (const round of stats.rounds) {
      lines.push(
        `- 第 ${round.round} 轮：耗时 ${round.durationMs} ms${
          round.usage === undefined ? '' : `，${usageLine(round.usage)}`
        }`,
      );
    }
  }
  const usage = sumRoundUsage(stats.rounds);
  if (usage !== undefined) lines.push(`usage 合计：${usageLine(usage)}`);
  return lines.join('\n');
}

/** 构造插件自产 user 消息（子会话统计消息；source 为插件自有 kind）。 */
function makeStatsMessage(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: omSource(),
  });
}

/**
 * 把一次压缩工具循环的完整会话消息组落盘为子会话：ctx.sessions.create 创建子会话
 * （header origin 'subagent'、parentSession 指向主会话、delegationDepth = 父 + 1、
 * cwd 继承主会话），追加 one-shot descriptor（provider om-compaction-log，label 含
 * 压缩阶段与轮数），逐消息按角色原样追加（assistant → assistant/message、tool →
 * tool/result、其余 → user/message），末尾追加插件来源统计消息（起止
 * 时间、总耗时、逐轮耗时与 usage），flush 持久化，返回子会话 id。成功与失败均调用；
 * 落盘自身绝不抛错，任何失败仅 logger.warn 并返回 undefined。
 */
export async function recordCompressionSession(
  ctx: Context,
  parentSession: Session,
  options: {
    /** 压缩 pass（记录 label 用）。 */
    phase: 'observe' | 'reflect' | undefined;
    /** 摘要调用的路由目标（assistant/message 的 model 来源标记）。 */
    target: RoutedTarget;
    /** 循环全部消息（user 指令/提醒、assistant 含 tool-call、tool-result，原样）。 */
    messages: readonly Message[];
    /** 循环统计（label 轮数与统计消息内容来源）。 */
    stats: CompressionStats;
    /** 是否成功完成（label 区分会话记录/失败日志）。 */
    success: boolean;
    /** 插件 debug 开关（落盘失败的 warn 是否带步骤细节）。 */
    debug: boolean;
  },
): Promise<string | undefined> {
  const logger = makeLogger(ctx, options.debug);
  try {
    const header = parentSession.header;
    const child = ctx.sessions.create(SessionId(`om-compaction-log-${uuid()}`), {
      meta: {
        ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
        parentSession: parentSession.id,
        origin: 'subagent',
        delegationDepth: (header.delegationDepth ?? 0) + 1,
      },
    });
    const label = compressionRecordLabel(
      options.phase,
      options.stats.rounds.length,
      options.success,
    );
    child.append('subagent/descriptor', {
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: 'one-shot',
      provider: COMPACTION_LOG_PROVIDER,
      label,
    });
    child.append('turn/start', { turn: 1 });
    let step = 0;
    const executed = new Set(
      options.messages
        .filter((message): message is ToolResultMessage => message.role === 'tool')
        .map((message) => message.toolCallId),
    );
    let pending: ToolCallBlock[] = [];
    const closeStep = (): void => {
      if (step === 0) return;
      for (const call of pending) {
        if (executed.has(call.id)) continue;
        const repair = createToolResultMessage({
          callId: call.id,
          content: [{ type: 'text', text: '压缩循环未执行此工具调用' }],
          isError: true,
        });
        child.append(
          'tool/result',
          {
            turn: 1,
            step,
            message: {
              ...repair,
              id: `forked-tool-result-${call.id}-${uuid()}` as ToolResultMessage['id'],
            },
            error: { name: 'ToolNotStartedError', code: 'TOOL_NOT_STARTED' },
          },
          { surfaceOp: 'append' },
        );
      }
      child.append('step/end', { turn: 1, step });
      pending = [];
    };
    for (const message of options.messages) {
      if (message.role === 'assistant') {
        closeStep();
        step += 1;
        child.append('step/start', { turn: 1, step });
        child.append(
          'assistant/message',
          { turn: 1, step, message: message as AssistantMessage, stream: [] },
          { surfaceOp: 'append' },
        );
        pending = message.content.filter(
          (block): block is ToolCallBlock => block.type === 'tool-call',
        );
        for (const call of pending) {
          if (!executed.has(call.id)) continue;
          child.append('tool/call', {
            turn: 1,
            step,
            callId: call.id,
            name: call.name,
            arguments: call.arguments,
          });
        }
      } else if (message.role === 'tool') {
        child.append(
          'tool/result',
          { turn: 1, step, message: message as ToolResultMessage },
          { surfaceOp: 'append' },
        );
      } else {
        child.append('user/message', message as UserMessage, { surfaceOp: 'append' });
      }
    }
    closeStep();
    child.append(
      'user/message',
      makeStatsMessage(formatCompressionStats(options.phase, options.success, options.stats)),
      { surfaceOp: 'append' },
    );
    child.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
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
    await ctx.sessions.flush(parentSession);
    return child.id;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`压缩会话记录子会话落盘失败: ${message}`);
    return undefined;
  }
}
