/**
 * OM 结果评估组件入口（dsh-plugin-om/compaction-eval）：导出 name / inject / apply。
 * 注册 /om-compaction-eval 命令：新建同工作区会话，由它按随包发布的 compaction-eval
 * 文档分析当前会话的 OM 压缩结果（见 compaction-eval-command.ts）。组件无配置项，
 * 不依赖包根行；sessionController / workspaceRegistry 经 ctx.get 容错读取，
 * 缺失时命令返回失败原因。
 */
import type {} from '@deepseek-ai/cordis-plugin-loader';
import type {} from '@deepseek-ai/dsh-commands';
import { buildCompactionEvalCommand } from '../compaction-eval-command.ts';
import type { Context } from '../types.ts';

/** 组件名（Loader 识别入口的稳定标识，与 patch 行的模块 specifier 一致）。 */
export const name = 'dsh-plugin-om/compaction-eval';

/** 必需依赖：命令通道（commands）。 */
export const inject = ['commands'];

/** 组件激活入口：注册 /om-compaction-eval 命令。 */
export function apply(ctx: Context): void {
  ctx.effect(
    () => ctx.commands.register(buildCompactionEvalCommand(ctx)),
    'dsh-plugin-om/compaction-eval: eval command',
  );
}
