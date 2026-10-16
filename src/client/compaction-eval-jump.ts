/**
 * /om-compaction-eval 的客户端跳转：命令由宿主原生执行（建会话、投递首条消息、
 * 结果提示都由宿主与外壳负责），本模块只监听本浏览器的 command/executed，
 * 从成功文本反解新会话 id 并跳转过去。
 * 导出 evalJumpTarget / registerCompactionEvalJump。
 */
import type { Context } from '@deepseek-ai/cordis';
// Type-only: command/executed 事件的 Events 合并（只有派发命令的本浏览器发布）。
import type {} from '@deepseek-ai/dsh-client-ui-commands/client';
import type { CommandResult } from '@deepseek-ai/dsh-commands/types';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import { EVAL_COMMAND_NAME, parseEvalSessionId } from '../eval-session-text.ts';

/**
 * 从一次命令执行取跳转目标：只认本命令的成功结果，且文本能反解出新会话 id。
 * 其他命令、失败结果与无法反解的文本都返回 undefined（不跳转）。
 */
export function evalJumpTarget(name: string, result: CommandResult): string | undefined {
  if (name !== EVAL_COMMAND_NAME || result.kind !== 'success') return undefined;
  return parseEvalSessionId(result.text ?? '');
}

/**
 * 监听命令执行完成并跳转到新会话。
 * @param ctx - 客户端根上下文（uiWorkspace 提供跳转）。
 * @returns 注销函数。
 */
export function registerCompactionEvalJump(ctx: Context): () => void {
  return ctx.on('command/executed', (_sessionId, name, result) => {
    const target = evalJumpTarget(name, result);
    if (target !== undefined) ctx.uiWorkspace.openSession(target as SessionId);
  });
}
