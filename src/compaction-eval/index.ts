/**
 * OM 结果评估组件入口（dsh-plugin-om/compaction-eval）：导出 name / inject / Config / apply。
 * 注册 /om-compaction-eval 命令：新建同工作区会话，由它按随包发布的 compaction-eval
 * 文档分析当前会话的 OM 压缩结果（见 compaction-eval-command.ts）。不依赖包根行；
 * sessionController / workspaceRegistry 经 ctx.get 容错读取，缺失时命令返回失败原因。
 */
import type {} from '@deepseek-ai/cordis-plugin-loader';
import type {} from '@deepseek-ai/dsh-commands';
import { buildCompactionEvalCommand } from '../compaction-eval-command.ts';
import { currentEvalConfig, EvalConfig } from '../config.ts';
import { makeLogger } from '../logger.ts';
import type { Context } from '../types.ts';

/** 组件名（Loader 识别入口的稳定标识，与 patch 行的模块 specifier 一致）。 */
export const name = 'dsh-plugin-om/compaction-eval';

export { EvalConfig as Config };

/** 必需依赖：命令通道（commands）。 */
export const inject = ['commands'];

/** 组件激活入口：注册 /om-compaction-eval，debug 日志按调用时刻读本行配置。 */
export function apply(ctx: Context, config?: unknown): void {
  const logger = makeLogger(ctx, () => currentEvalConfig(config).debug);
  logger.step('OM 结果评估组件启动');
  ctx.effect(
    () =>
      ctx.commands.register(buildCompactionEvalCommand(ctx, () => currentEvalConfig(config).debug)),
    'dsh-plugin-om/compaction-eval: eval command',
  );
}
