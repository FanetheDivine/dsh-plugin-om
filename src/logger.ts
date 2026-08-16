/**
 * 日志辅助：步骤级（debug）日志默认仅 dev（非 production）输出，便于开发调试；
 * 失败等关键日志始终输出（不受 dev 开关影响）。
 * 开关环境变量 DSH_OM_DEBUG：值 === 'true' 强制开启、'false' 强制关闭，
 * 缺省按 NODE_ENV !== 'production' 判定（dev/test 输出，生产隐藏）。
 */
import { PLUGIN_LABEL } from './constants.ts';
import type { Context } from './types.ts';

/** 步骤级 debug 日志开关环境变量名（'true' 强制开 / 'false' 强制关 / 缺省按 NODE_ENV）。 */
export const DEBUG_ENV = 'DSH_OM_DEBUG';

/**
 * 判定步骤级日志是否输出：DSH_OM_DEBUG=true 强制开、=false 强制关；
 * 未设置时非 production（NODE_ENV !== 'production'，含 dev/test）输出。
 */
export function stepLogEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env[DEBUG_ENV];
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return env.NODE_ENV !== 'production';
}

/** 插件日志门面：step=步骤级（debug，dev 输出）；info/warn 始终输出（失败必达）。 */
export type PluginLogger = {
  /** 步骤级日志（debug 级，仅 dev/调试环境输出）。 */
  step(message: string): void;
  /** 常规信息（始终输出）。 */
  info(message: string): void;
  /** 警告/失败（始终输出，重试与失败诊断依赖）。 */
  warn(message: string): void;
};

/** 构建插件日志门面：统一加 PLUGIN_LABEL 前缀，step 按 dev 开关过滤。 */
export function makeLogger(ctx: Context): PluginLogger {
  /** 步骤级日志是否输出（创建门面时求值一次）。 */
  const enabled = stepLogEnabled();
  return {
    step(message: string): void {
      if (enabled) ctx.logger.debug(`${PLUGIN_LABEL}: ${message}`);
    },
    info(message: string): void {
      ctx.logger.info(`${PLUGIN_LABEL}: ${message}`);
    },
    warn(message: string): void {
      ctx.logger.warn(`${PLUGIN_LABEL}: ${message}`);
    },
  };
}
