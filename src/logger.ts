/**
 * 插件日志门面：step 为步骤级（debug）日志，按配置开关过滤；info/warn 始终输出。
 * 导出 PluginLogger / makeLogger。
 */
import { PLUGIN_LABEL } from './constants.ts';
import type { Context } from './types.ts';

/** 插件日志门面：step=步骤级（debug）；info/warn 始终输出。 */
export type PluginLogger = {
  /** 步骤级日志（仅 debug 开启时输出）。 */
  step(message: string): void;
  /** 常规信息（始终输出）。 */
  info(message: string): void;
  /** 警告/失败（始终输出）。 */
  warn(message: string): void;
};

/** 构建插件日志门面：统一加 PLUGIN_LABEL 前缀，step 按 debug 开关过滤。 */
export function makeLogger(ctx: Context, debug: boolean): PluginLogger {
  return {
    step(message: string): void {
      if (debug) ctx.logger.debug(`${PLUGIN_LABEL}: ${message}`);
    },
    info(message: string): void {
      ctx.logger.info(`${PLUGIN_LABEL}: ${message}`);
    },
    warn(message: string): void {
      ctx.logger.warn(`${PLUGIN_LABEL}: ${message}`);
    },
  };
}
