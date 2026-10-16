/**
 * /om-compaction-eval 命令：在被分析会话所属工作区新建一个会话，由它按随包发布的
 * compaction-eval 文档分析当前会话的 OM 压缩结果，本会话上下文不受影响。
 * 文档路径由本模块自身位置推出：发布产物优先，仓库源码兜底。
 * 导出 skillDocCandidates / skillDocPath / StartEvalResult / startEvalSession /
 * buildCompactionEvalCommand。
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller';
import { brandString } from '@deepseek-ai/dsh-brand';
import type { CommandDefinition } from '@deepseek-ai/dsh-commands';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace';

import {
  buildEvalPrompt,
  EVAL_COMMAND_DESCRIPTION,
  EVAL_COMMAND_NAME,
  evalStartedText,
} from './eval-session-text.ts';
import type { Agent, Context } from './types.ts';
import { isMainSession, uuid } from './utils.ts';

/**
 * skill 文档候选绝对路径，按优先级排列：
 * 1. 发布产物 dist/skill/compaction-eval/SKILL.md（脚本为自包含 .mjs）；
 * 2. 仓库源码 .agents/skills/compaction-eval/SKILL.md（开发时 dist 未构建）。
 * @param fromUrl - 入口模块 URL，缺省为本模块（打包后即 dist/index.mjs）。
 */
export function skillDocCandidates(fromUrl: string | URL = import.meta.url): string[] {
  return [
    fileURLToPath(new URL('./skill/compaction-eval/SKILL.md', fromUrl)),
    fileURLToPath(new URL('../.agents/skills/compaction-eval/SKILL.md', fromUrl)),
  ];
}

/**
 * 第一个存在的 skill 文档路径。
 * @param fromUrl - 入口模块 URL，缺省为本模块。
 * @returns 文档绝对路径；都不存在时 undefined。
 */
export function skillDocPath(fromUrl: string | URL = import.meta.url): string | undefined {
  return skillDocCandidates(fromUrl).find((candidate) => existsSync(candidate));
}

/** 启动结果：成功带新会话 id 与命令文本，失败带原因。 */
export type StartEvalResult =
  | { readonly ok: true; readonly sessionId: string; readonly text: string }
  | { readonly ok: false; readonly error: string };

/** 当前会话所属工作区 id；宿主无 workspaceRegistry 或会话未归属时 undefined。 */
function workspaceOf(ctx: Context, sessionId: SessionId): WorkspaceId | undefined {
  const registry = ctx.get('workspaceRegistry');
  if (registry === undefined) return undefined;
  return registry.list().find((workspace) => workspace.sessionIds.includes(sessionId))?.id;
}

/**
 * 新建同工作区会话并投递首条消息。
 * 非主会话、会话无 cwd、文档缺失或宿主缺 sessionController 时返回失败且不建会话；
 * 建会话与投递的异常归一为失败原因。
 * @param ctx - 宿主上下文（经 ctx.get 容错读取 sessionController 与 workspaceRegistry）。
 * @param agent - 命令所针对的会话，其 id 与 cwd 决定分析目标与新会话位置。
 * @param signal - 命令取消信号，透传给投递。
 */
export async function startEvalSession(
  ctx: Context,
  agent: Agent,
  signal: AbortSignal,
): Promise<StartEvalResult> {
  const session = agent.session;
  if (!isMainSession(session)) return { ok: false, error: 'OM 结果分析仅支持主会话' };
  const cwd = session.header?.cwd;
  if (cwd === undefined || cwd === '') return { ok: false, error: '当前会话没有工作区信息' };
  const docPath = skillDocPath();
  if (docPath === undefined) return { ok: false, error: '找不到 compaction-eval 文档' };
  const controller = ctx.get('sessionController');
  if (controller === undefined) return { ok: false, error: '宿主未提供 sessionController 服务' };
  const workspaceId = workspaceOf(ctx, session.id);
  const preset = session.header?.agentPreset;
  try {
    // 有归属工作区时按 workspaceId 建会话：新会话落在同一工作区并出现在会话列表
    const created = await controller.create({
      ...(workspaceId === undefined ? { cwd } : { workspaceId }),
      ...(preset === undefined ? {} : { agentPreset: preset }),
    });
    await controller.prompt(
      {
        requestId: brandString<SessionRequestId>(uuid()),
        sessionId: created.sessionId,
        mode: 'queue',
        content: [
          {
            type: 'text',
            text: buildEvalPrompt({
              docPath,
              cwd,
              ...(workspaceId === undefined ? {} : { workspaceId }),
              sessionId: session.id,
            }),
          },
        ],
      },
      signal,
    );
    return { ok: true, sessionId: created.sessionId, text: evalStartedText(created.sessionId) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 构造 /om-compaction-eval 命令定义：无参数，裸调用即在宿主执行。 */
export function buildCompactionEvalCommand(ctx: Context): CommandDefinition {
  return {
    name: EVAL_COMMAND_NAME,
    description: EVAL_COMMAND_DESCRIPTION,
    handler: async ({ agent, signal }) => {
      const result = await startEvalSession(ctx, agent, signal);
      return result.ok
        ? { kind: 'success', text: result.text }
        : { kind: 'error', text: result.error };
    },
  };
}
