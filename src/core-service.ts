/**
 * 压缩核心服务：包根行经 ctx.provide 暴露当前压缩配置，组件行 inject 后读取。
 * 包根行停用时服务随之撤销，依赖它的组件自动停用。
 * 导出 OM_COMPACTION_SERVICE / OmCompactionService / provideCompactionService。
 */
import type { PluginConfig } from './config.ts';
import type { Context } from './types.ts';

/** 压缩核心服务名。 */
export const OM_COMPACTION_SERVICE = 'omCompaction';

/** 压缩核心服务：按调用时刻读取包根行配置。 */
export interface OmCompactionService {
  /** 包根行当前配置（volatile 提交后立即反映新值）。 */
  config(): Readonly<PluginConfig>;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** dsh-plugin-om 压缩核心服务（包根行提供）。 */
    omCompaction: OmCompactionService;
  }
}

/**
 * 在包根行 fiber 上提供压缩核心服务，fiber 卸载时自动撤销。
 * @param ctx - 包根行上下文。
 * @param config - 读取当前配置的函数。
 * @returns 撤销服务的函数。
 */
export function provideCompactionService(
  ctx: Context,
  config: () => Readonly<PluginConfig>,
): () => void {
  const service: OmCompactionService = { config };
  return ctx.provide(OM_COMPACTION_SERVICE, service);
}
