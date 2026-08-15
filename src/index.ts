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
 *    反思（摘要 ≥ 窗口 × historyMergeRatio 时 fork 精简合并 <om-history>）、
 *    观察（未压缩消息 ≥ 窗口 × thresholdRatio 时 fork 压缩为观察日志并追加）
 *
 * 约束：不引入自定义会话事件类型——压缩复用宿主已知的 compaction/* 生命周期事件
 * （start/summary/end）与 checkpoint 标记，结果写入消息记录与轨迹。
 * 仅主会话生效（subagent 不压缩、recall 拒绝）。
 */

import { maybeCompress } from './compress.ts';
import { resolveConfig } from './config.ts';
import { getEmbedder } from './embedding.ts';
import { buildRecallTool } from './recall.ts';
import { buildSemanticRecallTool } from './semantic-recall.ts';
import type { Context } from './types.ts';
import { isMainSession } from './utils.ts';

/** 插件名（Loader 识别入口的稳定标识）。 */
export const name = 'dsh-plugin-om';

/** 插件注入的服务依赖（tools/llm/tokenMeter/sessions），由宿主按序注入。 */
export const inject = ['tools', 'llm', 'tokenMeter', 'sessions'];

/**
 * 插件激活入口：注册 recall / recall-semantic 工具，并在 agent/pre-step 阻塞触发
 * 两级自动压缩（先反思后观察）。仅主会话生效。
 */
export function apply(ctx: Context, config?: unknown): void {
  /** 解析后的插件配置（默认值合并 + 校验）。 */
  const resolved = resolveConfig(config);

  // recall 工具（code 呈现下即 SDK 绑定 tools.recall(...)）；输出 token 由
  // tool-result-pruner 控制（recall 渲染超大的工具结果时调用其 pruneContent）
  ctx.tools.register(buildRecallTool(() => ctx.get('toolResultPruner')));

  // recall-semantic 工具：本地 ONNX embedding（懒加载，首次调用才加载模型），
  // 输出同样由 tool-result-pruner 裁剪
  ctx.tools.register(
    buildSemanticRecallTool({
      getPruner: () => ctx.get('toolResultPruner'),
      embedder: (texts) => getEmbedder(resolved.modelDir).then((embed) => embed(texts)),
    }),
  );

  // 两级自动压缩：pre-step 阻塞串行（先反思压缩过往摘要，后观察压缩新消息），
  // 失败不影响主流程；仅主会话（subagent 不压缩）。
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    try {
      if (!signal.aborted && isMainSession(agent.session)) {
        await maybeCompress(ctx, agent, resolved, signal);
      }
    } catch (error) {
      ctx.logger.warn(
        'dsh-plugin-om: pre-step 处理失败: ' +
          (error instanceof Error ? error.message : String(error)),
      );
    }
    return next();
  });
}
