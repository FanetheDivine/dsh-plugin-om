/**
 * 压缩会话记录落盘：把工具压缩循环的完整会话消息组原样落盘为一个 one-shot 诊断
 * 子会话（header origin 'subagent' + 首事件 subagent/descriptor），使其以 subagent
 * 形式出现在宿主子代理列表中，便于查看压缩循环的完整会话。成功与失败均落盘
 * （label 区分）。导出 recordCompressionSession / compressionRecordLabel /
 * COMPACTION_LOG_PROVIDER。
 *
 * - 子会话内容零加工：循环消息组（user 指令/提醒、assistant 含 tool-call、
 *   tool-result）逐条原样追加，不插入任何额外消息；失败原因不进子会话，走主会话
 *   日志与 compaction/end error 载荷
 * - 失败时的子会话 id 由调用方写入主会话日志与 compaction/end 载荷（compress.ts /
 *   index.ts）
 * - 落盘自身绝不抛错：任何失败仅 logger.warn 并返回 undefined，不影响压缩流程
 */

import type { AssistantMessage, Message, UserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { SUBAGENT_DESCRIPTOR_VERSION } from '@deepseek-ai/dsh-subagent';
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

/**
 * 把一次压缩工具循环的完整会话消息组落盘为子会话：ctx.sessions.create 创建子会话
 * （header origin 'subagent'、parentSession 指向主会话、delegationDepth = 父 + 1、
 * cwd 继承主会话），追加 one-shot descriptor（provider om-compaction-log，label 含
 * 压缩阶段与轮数），逐消息原样追加（user 指令/提醒与 tool-result 为 user/message，
 * assistant 含 tool-call 块为 assistant/message），flush 持久化，返回子会话 id。
 * 成功与失败均调用；落盘自身绝不抛错，任何失败仅 logger.warn 并返回 undefined。
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
    /** 模型请求轮数。 */
    rounds: number;
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
    child.append('subagent/descriptor', {
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: 'one-shot',
      provider: COMPACTION_LOG_PROVIDER,
      label: compressionRecordLabel(options.phase, options.rounds, options.success),
    });
    let step = 0;
    for (const message of options.messages) {
      step += 1;
      if (message.role === 'assistant') {
        child.append(
          'assistant/message',
          // 记录会话不运行 agent loop：turn 固定 0，step 标注消息序号（1 起）
          { turn: 0, step, message: message as AssistantMessage },
          { surfaceOp: 'append' },
        );
      } else {
        child.append('user/message', message as UserMessage, { surfaceOp: 'append' });
      }
    }
    try {
      await ctx.sessions.flush(child);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`压缩会话记录子会话 flush 失败（子会话 ${child.id} 已创建）: ${message}`);
    }
    return child.id;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`压缩会话记录子会话落盘失败: ${message}`);
    return undefined;
  }
}
