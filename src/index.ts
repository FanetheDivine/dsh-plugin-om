/**
 * dsh-plugin-om 入口（tsdown 打包入口）：导出 name / inject / Config / apply。
 * apply 维护 recall / recall-semantic 工具列表，处理 Loader volatile 配置提交，
 * 并接线 agent/pre-step 自动压缩
 * （先反思后观察，仅主会话生效）。压缩走工具驱动的压缩循环（模型经 getHistory /
 * compressHistory / completeCompression 工具完成，见 compress-loop.ts）；最终失败
 * （连续无工具调用 / 请求级错误）时拒绝本 step 中断当前 turn（signal 中止除外），
 * 主会话日志记录失败原因与诊断子会话 sessionId（完整循环会话由 compaction-log.ts
 * 落盘为子会话）。压缩与检索的实现见 compress.ts / compress-loop.ts /
 * compaction-log.ts / recall.ts / semantic-recall.ts。
 */
import type {} from '@deepseek-ai/cordis-plugin-loader';
import { type CompressPassResult, maybeCompress } from './compress.ts';
import { Config, currentConfig } from './config.ts';
import { ensureModelReady, getEmbedder } from './embedding.ts';
import { makeLogger } from './logger.ts';
import { buildRecallTool } from './recall.ts';
import { buildSemanticRecallTool } from './semantic-recall.ts';
import type { Context } from './types.ts';
import { isMainSession } from './utils.ts';

/** 插件名（Loader 识别入口的稳定标识）。 */
export const name = 'dsh-plugin-om';

export { Config };

/** 插件注入的服务依赖（tools/llm/tokenMeter/sessions），由宿主按序注入。 */
export const inject = ['tools', 'llm', 'tokenMeter', 'sessions'];

/** 插件激活入口：解析配置、注册工具、接线 pre-step 自动压缩。 */
export function apply(ctx: Context, config?: unknown): void {
  const resolved = currentConfig(config);
  const logger = makeLogger(ctx, () => currentConfig(config).debug);
  logger.step(
    `apply 启动：observeThresholdTokens=${String(resolved.observeThresholdTokens)} reflectThresholdTokens=${String(resolved.reflectThresholdTokens)} compressMaxTokens=${
      resolved.compressMaxTokens === undefined ? '未设置' : String(resolved.compressMaxTokens)
    } tailMessageCount=${String(resolved.tailMessageCount)} omEnabled=${String(resolved.omEnabled)} debug=${String(resolved.debug)} compressProvider=${
      resolved.compressProvider ?? '跟随会话路由'
    } compressModel=${resolved.compressModel ?? '跟随会话路由'} compressReasoningEffort=${
      resolved.compressReasoningEffort ?? '模型默认'
    }`,
  );

  const warnModel = (message: string) => ctx.logger.warn(`dsh-plugin-om: ${message}`);
  const logModel = (message: string) => logger.info(message);
  let disposeRecall: (() => void) | undefined;
  let disposeSemantic: (() => void) | undefined;
  let modelDir = resolved.modelDir;
  let semanticEnabled = false;

  /** 保持实际注册列表与当前配置一致；仅首次启用或更换目录时启动后台预热。 */
  function syncTools(): void {
    const next = currentConfig(config);
    if (next.recallEnabled && !disposeRecall) {
      disposeRecall = ctx.tools.register(buildRecallTool(() => ctx.get('toolResultPruner')));
    } else if (!next.recallEnabled && disposeRecall) {
      disposeRecall();
      disposeRecall = undefined;
    }
    if (disposeSemantic && (!next.semanticRecallEnabled || next.modelDir !== modelDir)) {
      disposeSemantic();
      disposeSemantic = undefined;
    }
    if (next.semanticRecallEnabled && !disposeSemantic) {
      const directory = next.modelDir;
      disposeSemantic = ctx.tools.register(
        buildSemanticRecallTool({
          getPruner: () => ctx.get('toolResultPruner'),
          modelStatus: () => ensureModelReady(directory, warnModel, undefined, logModel),
          embedder: (texts) => getEmbedder(directory).then((embed) => embed(texts)),
        }),
      );
    }
    if (next.semanticRecallEnabled && (!semanticEnabled || next.modelDir !== modelDir)) {
      void ensureModelReady(next.modelDir, warnModel, undefined, logModel);
    }
    modelDir = next.modelDir;
    semanticEnabled = next.semanticRecallEnabled;
  }
  syncTools();
  ctx.on('loader/volatile-update', () => syncTools());

  // 两级自动压缩：pre-step 阻塞串行（先反思后观察）；仅主会话生效。
  // 压缩循环最终失败（非 signal 中止）时拒绝本 step：当前 turn 以 blocked 结束，
  // 不再继续 AI 会话（实际报错已写入日志与 compaction/end error，UI 渲染失败行）。
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    let outcome: CompressPassResult = { failed: false };
    try {
      if (signal.aborted) {
        logger.step('pre-step 已中止（signal aborted），跳过压缩');
      } else if (!isMainSession(agent.session)) {
        logger.step('subagent 会话，跳过压缩（仅主会话生效）');
      } else {
        logger.step(`pre-step 触发压缩（会话 ${agent.session.id}）`);
        outcome = await maybeCompress(ctx, agent, currentConfig(config), signal);
      }
    } catch (error) {
      logger.warn(`pre-step 处理失败: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (outcome.failed && !outcome.aborted) {
      const diagnostic =
        outcome.diagnosticSessionId === undefined
          ? ''
          : `（诊断子会话 ${outcome.diagnosticSessionId}）`;
      logger.warn(`上下文压缩失败，拒绝本 step 中断当前 turn：${outcome.error}${diagnostic}`);
      return { kind: 'reject' };
    }
    return next();
  });
}
