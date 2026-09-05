/**
 * dsh-plugin-om 入口（tsdown 打包入口）：导出 name / inject / apply。
 * apply 注册 recall / recall-semantic 工具，并接线 agent/pre-step 自动压缩
 * （先反思后观察，仅主会话生效）。压缩摘要尝试全部耗尽时拒绝本 step 中断当前
 * turn（signal 中止除外），主会话日志记录失败原因与诊断子会话 sessionId（每次
 * 尝试的完整提示词与模型原始输出由 compaction-log.ts 落盘为诊断子会话）。压缩与
 * 检索的实现见 compress.ts / compaction-log.ts / recall.ts / semantic-recall.ts。
 */
import { type CompressPassResult, maybeCompress } from './compress.ts';
import { resolveConfig } from './config.ts';
import { ensureModelReady, getEmbedder } from './embedding.ts';
import { makeLogger } from './logger.ts';
import { buildRecallTool } from './recall.ts';
import { buildSemanticRecallTool } from './semantic-recall.ts';
import type { Context } from './types.ts';
import { isMainSession } from './utils.ts';

/** 插件名（Loader 识别入口的稳定标识）。 */
export const name = 'dsh-plugin-om';

/** 插件注入的服务依赖（tools/llm/tokenMeter/sessions），由宿主按序注入。 */
export const inject = ['tools', 'llm', 'tokenMeter', 'sessions'];

/** 插件激活入口：解析配置、注册工具、接线 pre-step 自动压缩。 */
export function apply(ctx: Context, config?: unknown): void {
  const resolved = resolveConfig(config);
  const logger = makeLogger(ctx, resolved.debug);
  logger.step(
    `apply 启动：observeThresholdTokens=${String(resolved.observeThresholdTokens)} reflectThresholdTokens=${String(resolved.reflectThresholdTokens)} compressMaxTokens=${
      resolved.compressMaxTokens === undefined ? '未设置' : String(resolved.compressMaxTokens)
    } tailMessageCount=${String(resolved.tailMessageCount)} omEnabled=${String(resolved.omEnabled)} debug=${String(resolved.debug)}`,
  );

  // recall 工具：超大输出由 tool-result-pruner 裁剪；recallEnabled=false 时不注册。
  if (resolved.recallEnabled) {
    ctx.tools.register(buildRecallTool(() => ctx.get('toolResultPruner')));
  }

  // recall-semantic 工具：本地 ONNX 嵌入懒加载；semanticRecallEnabled=false 时不注册。
  // 启用时若模型 onnx 缺失则后台预热下载（不阻塞，失败记日志，下次查询自动重试）。
  if (resolved.semanticRecallEnabled) {
    const warnModel = (message: string) => ctx.logger.warn(`dsh-plugin-om: ${message}`);
    const logModel = (message: string) => logger.info(message);
    void ensureModelReady(resolved.modelDir, warnModel, undefined, logModel);
    ctx.tools.register(
      buildSemanticRecallTool({
        getPruner: () => ctx.get('toolResultPruner'),
        modelStatus: () => ensureModelReady(resolved.modelDir, warnModel, undefined, logModel),
        embedder: (texts) => getEmbedder(resolved.modelDir).then((embed) => embed(texts)),
      }),
    );
  }

  // 两级自动压缩：pre-step 阻塞串行（先反思后观察）；仅主会话生效。
  // 摘要尝试全部耗尽（非 signal 中止）时拒绝本 step：当前 turn 以 blocked 结束，
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
        outcome = await maybeCompress(ctx, agent, resolved, signal);
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
