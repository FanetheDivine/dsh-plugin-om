/**
 * 重压缩组件入口（dsh-plugin-om/recompress）：导出 name / inject / Config / apply。
 * 注册 /om-recompress 命令；压缩参数读包根行的压缩核心服务（omCompaction，见
 * core-service.ts），并发上限与步骤级日志读本行配置。包根行停用时服务缺失，
 * 本组件由 Loader 自动停用。
 */
import type {} from '@deepseek-ai/cordis-plugin-loader';
import type {} from '@deepseek-ai/dsh-commands';
import { currentRecompressConfig, RecompressConfig } from '../config.ts';
import { OM_COMPACTION_SERVICE, type OmCompactionService } from '../core-service.ts';
import { makeLogger } from '../logger.ts';
import { buildRecompressCommand, type RecompressRuntime } from '../recompress.ts';
import type { Context } from '../types.ts';

/** 组件名（Loader 识别入口的稳定标识，与 patch 行的模块 specifier 一致）。 */
export const name = 'dsh-plugin-om/recompress';

export { RecompressConfig as Config };

/**
 * 必需依赖：压缩请求（llm）、命令通道（commands）与压缩核心服务（omCompaction）。
 * 任一缺失时组件不挂载；核心服务由包根行提供，包根行停用即本组件停用。
 */
export const inject = ['llm', 'commands', OM_COMPACTION_SERVICE];

/** 组件激活入口：注册 /om-recompress，配置按调用时刻读取（volatile 热更新即时生效）。 */
export function apply(ctx: Context, config?: unknown): void {
  const core: OmCompactionService = ctx.omCompaction;
  const logger = makeLogger(ctx, () => currentRecompressConfig(config).debug);
  const initial = currentRecompressConfig(config);
  logger.step(`重压缩组件启动：recompressConcurrency=${String(initial.recompressConcurrency)}`);
  /** 组装运行时参数：压缩参数来自核心服务，debug 与并发上限来自本行配置。 */
  const getRuntime = (): Readonly<RecompressRuntime> => {
    const coreConfig = core.config();
    const row = currentRecompressConfig(config);
    return {
      compressMaxTokens: coreConfig.compressMaxTokens,
      compressSkipReasoning: coreConfig.compressSkipReasoning,
      rateLimitWaitMs: coreConfig.rateLimitWaitMs,
      debug: row.debug,
      recompressConcurrency: row.recompressConcurrency,
    };
  };
  ctx.effect(
    () => ctx.commands.register(buildRecompressCommand(ctx, getRuntime)),
    'dsh-plugin-om/recompress: recompress command',
  );
}
