/**
 * dsh-plugin-om — Observational Memory（OM）上下文压缩 + recall 检索插件。
 * 不依赖特定 tool mode（native / code / both 均可运行）。
 *
 * 模块：
 *  - recall.ts  recall({ start_id, end_id?, offset? }) 工具：按 message_id 回看原始会话
 *  - semantic-recall.ts  recall-semantic({ query, top_k?, start_id?, end_id?, offset? }) 工具：
 *    按语义在全部消息日志（含被压缩/遮蔽）中检索，返回最匹配的完整消息与匹配说明
 *    （本地 ONNX embedding，模型随插件打包，懒加载）
 *  - compress.ts 自动压缩（OM 观察/反思两级阈值）：pre-step 阻塞串行执行——
 *    反思（摘要 ≥ 窗口 × historyMergeRatio 时摘要调用精简合并 <om-history>）、
 *    观察（未压缩消息 ≥ 窗口 × thresholdRatio 时摘要调用压缩为观察日志并追加）
 *
 * 约束：不引入自定义会话事件类型——压缩复用宿主已知的 compaction/* 生命周期事件
 * （start/summary/end）与 checkpoint 标记，结果写入消息记录与轨迹。
 * 仅主会话生效（subagent 不压缩、recall 拒绝）。
 */

import { maybeCompress } from './compress.ts';
import { resolveConfig } from './config.ts';
import { RECALL_ENABLED_ENV, SEMANTIC_RECALL_ENABLED_ENV } from './constants.ts';
import { ensureModelReady, getEmbedder } from './embedding.ts';
import { makeLogger } from './logger.ts';
import { buildRecallTool } from './recall.ts';
import { buildSemanticRecallTool } from './semantic-recall.ts';
import type { Context } from './types.ts';
import { envFlagEnabled, isMainSession } from './utils.ts';

/** 插件名（Loader 识别入口的稳定标识）。 */
export const name = 'dsh-plugin-om';

/** 插件注入的服务依赖（tools/llm/tokenMeter/sessions），由宿主按序注入。 */
export const inject = ['tools', 'llm', 'tokenMeter', 'sessions'];

/**
 * 插件激活入口：注册 recall / recall-semantic 工具，并在 agent/pre-step 阻塞触发
 * 两级自动压缩（先反思后观察）。仅主会话生效。
 */
export function apply(ctx: Context, config?: unknown): void {
  /** 插件日志门面（step=debug 仅 dev 输出；info/warn 始终输出）。 */
  const logger = makeLogger(ctx);
  /** 解析后的插件配置（默认值合并 + 校验）。 */
  const resolved = resolveConfig(config);
  logger.step(
    `apply 启动：thresholdRatio=${String(resolved.thresholdRatio)} historyMergeRatio=${String(resolved.historyMergeRatio)} compressMaxTokens=${String(resolved.compressMaxTokens)} tailMessageCount=${String(resolved.tailMessageCount)} summaryMode=${resolved.summaryMode}`,
  );

  // recall 工具（code 呈现下即 SDK 绑定 tools.recall(...)）；输出 token 由
  // tool-result-pruner 控制（recall 渲染超大的工具结果时调用其 pruneContent）。
  // 环境变量 OM_RECALL_ENABLED=false 时禁用（不注册该工具）。
  if (envFlagEnabled(RECALL_ENABLED_ENV)) {
    ctx.tools.register(buildRecallTool(() => ctx.get('toolResultPruner')));
  }

  // recall-semantic 工具：本地 ONNX embedding（懒加载，首次调用才加载模型），
  // 输出同样由 tool-result-pruner 裁剪。
  // 环境变量 OM_SEMANTIC_RECALL_ENABLED=false 时禁用（不注册，也不触发模型下载）。
  // 运行时按需下载：仅当 env 启用且模型 onnx 缺失时后台预热（不阻塞）；下载失败
  // 仅记日志，查询时未就绪由工具告知模型，下次查询自动重试。
  if (envFlagEnabled(SEMANTIC_RECALL_ENABLED_ENV)) {
    const warnModel = (message: string) => ctx.logger.warn('dsh-plugin-om: ' + message);
    void ensureModelReady(resolved.modelDir, warnModel);
    ctx.tools.register(
      buildSemanticRecallTool({
        getPruner: () => ctx.get('toolResultPruner'),
        modelStatus: () => ensureModelReady(resolved.modelDir, warnModel),
        embedder: (texts) => getEmbedder(resolved.modelDir).then((embed) => embed(texts)),
      }),
    );
  }

  // 两级自动压缩：pre-step 阻塞串行（先反思压缩过往摘要，后观察压缩新消息），
  // 失败不影响主流程；仅主会话（subagent 不压缩）。
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    try {
      if (signal.aborted) {
        logger.step('pre-step 已中止（signal aborted），跳过压缩');
      } else if (!isMainSession(agent.session)) {
        logger.step('subagent 会话，跳过压缩（仅主会话生效）');
      } else {
        logger.step(`pre-step 触发压缩（会话 ${agent.session.id}）`);
        await maybeCompress(ctx, agent, resolved, signal);
      }
    } catch (error) {
      logger.warn(`pre-step 处理失败: ${error instanceof Error ? error.message : String(error)}`);
    }
    return next();
  });
}
