/**
 * 日志辅助：步骤级（debug）日志默认仅 dev（非 production）输出，便于开发调试；
 * 失败等关键日志始终输出（不受 debug 开关影响）。
 * 开关配置键 debug：true 强制开启、false 强制关闭，缺省按 NODE_ENV !== 'production' 判定
 * （默认值由 resolveConfig 解析，见 config.ts）。
 */
import { PLUGIN_LABEL } from './constants.ts';
import type { Context } from './types.ts';

/** 插件日志门面：step=步骤级（debug，dev 输出）；info/warn 始终输出（失败必达）。 */
export type PluginLogger = {
  /** 步骤级日志（debug 级，仅 dev/调试环境输出）。 */
  step(message: string): void;
  /** 常规信息（始终输出）。 */
  info(message: string): void;
  /** 警告/失败（始终输出，重试与失败诊断依赖）。 */
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
