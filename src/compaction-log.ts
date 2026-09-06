/**
 * 压缩调用日志落盘：摘要 run 的每次 LLM 调用（每次尝试，无论成功失败）完成后，
 * 把该次尝试的完整提示词与模型原始输出原样落盘为一个 one-shot 诊断子会话
 * （header origin 'subagent' + 首事件 subagent/descriptor），使其以 subagent 形式
 * 出现在宿主子代理列表中，便于查验每次调用的完整会话。导出 recordCompactionAttempt /
 * SummaryAttemptRecord / compactionLogLabel / COMPACTION_LOG_PROVIDER。
 *
 * - 子会话内容零加工：一对 user/message（实际提示词全文，含 <history> 块）
 *   + assistant/message（模型原始输出全文，异常/中止时为已收集的部分输出），
 *   不插入任何额外消息；成败与原因不进子会话，由调用方写入主会话日志并关联子会话 id
 * - 落盘自身绝不抛错：任何失败仅 logger.warn 并返回 undefined，不影响压缩流程
 */

import type { AssistantMessage, UserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { SUBAGENT_DESCRIPTOR_VERSION } from '@deepseek-ai/dsh-subagent';
import { PLUGIN_LABEL } from './constants.ts';
import { makeLogger } from './logger.ts';
import type { Context, Session } from './types.ts';
import { type RoutedTarget, uuid } from './utils.ts';

/** 诊断子会话的 descriptor provider（宿主子代理列表识别用）。 */
export const COMPACTION_LOG_PROVIDER = 'om-compaction-log';

/** 一次摘要尝试的完整记录：prompt=实际提示词全文（含 <history> 块），rawOutput=模型原始输出全文。 */
export type SummaryAttemptRecord = { prompt: string; rawOutput: string };

/** 压缩 pass 的中文标签（诊断子会话 label 用；未知阶段回落「压缩」）。 */
function phaseLabel(phase: 'observe' | 'reflect' | undefined): string {
  if (phase === 'observe') return '观察';
  if (phase === 'reflect') return '反思';
  return '压缩';
}

/** 诊断子会话 label：`OM会话-<阶段>`，有重试时追加 `-重试N`（N = 尝试序号 - 1，首次不写）。 */
export function compactionLogLabel(
  phase: 'observe' | 'reflect' | undefined,
  attemptNo: number,
): string {
  const retry = attemptNo > 1 ? `-重试${attemptNo - 1}` : '';
  return `OM会话-${phaseLabel(phase)}${retry}`;
}

/** 追加一次尝试的「提示词 → 原始输出」消息组（surfaceOp append；id 为品牌类型，session.append 运行时校验）。 */
function appendAttemptMessages(
  child: Session,
  attempt: SummaryAttemptRecord,
  step: number,
  target: RoutedTarget,
): void {
  const userMessage = {
    id: uuid(),
    role: 'user',
    content: [{ type: 'text', text: attempt.prompt }],
    source: { kind: 'plugin', plugin: PLUGIN_LABEL },
  } as unknown as UserMessage;
  child.append('user/message', userMessage, { surfaceOp: 'append' });
  const assistantMessage = {
    id: uuid(),
    role: 'assistant',
    content: [{ type: 'text', text: attempt.rawOutput }],
    source: { kind: 'model', provider: target.provider, model: target.model },
  } as unknown as AssistantMessage;
  child.append(
    'assistant/message',
    // 诊断会话不运行 agent loop：turn 固定 0，step 固定 1（子会话只含单次尝试）
    { turn: 0, step, message: assistantMessage },
    { surfaceOp: 'append' },
  );
}

/**
 * 把一次摘要尝试落盘为诊断子会话：ctx.sessions.create 创建子会话（header origin
 * 'subagent'、parentSession 指向主会话、delegationDepth = 父 + 1、cwd 继承主会话），
 * 追加 one-shot descriptor（provider om-compaction-log，label 为 `OM会话-<阶段>`，重试时追加 `-重试N`），
 * 原样追加「提示词 + 原始输出」消息组，flush 持久化检查点，返回子会话 id。落盘自身
 * 绝不抛错：任何失败仅 logger.warn 并返回 undefined（不影响压缩流程）。
 */
export async function recordCompactionAttempt(
  ctx: Context,
  parentSession: Session,
  options: {
    /** 压缩 pass（诊断子会话 label 用）。 */
    phase: 'observe' | 'reflect' | undefined;
    /** 摘要调用的路由目标（assistant/message 的 model 来源标记）。 */
    target: RoutedTarget;
    /** 本次尝试的完整记录（提示词 + 原始输出）。 */
    attempt: SummaryAttemptRecord;
    /** 尝试序号（1 起，label 与消息 step 标注用）。 */
    attemptNo: number;
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
    child.append('subagent/descriptor', {
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: 'one-shot',
      provider: COMPACTION_LOG_PROVIDER,
      label: compactionLogLabel(options.phase, options.attemptNo),
    });
    appendAttemptMessages(child, options.attempt, 1, options.target);
    try {
      await ctx.sessions.flush(child);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`压缩日志子会话 flush 失败（子会话 ${child.id} 已创建）: ${message}`);
    }
    return child.id;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`压缩日志子会话落盘失败（第 ${options.attemptNo} 次尝试）: ${message}`);
    return undefined;
  }
}
