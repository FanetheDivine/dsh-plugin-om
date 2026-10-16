/**
 * dsh-plugin-om 入口（tsdown 打包入口）：导出 name / inject / Config / apply。
 * apply 维护 recall 工具（含语义增强），处理 Loader volatile 配置提交，
 * 并接线 agent/pre-step 自动压缩（先反思后观察，仅主会话生效）与提醒补发
 * （进度提醒的 system-reminder 用户消息，见 system-reminder.ts），
 * commands 服务可用时注册换模型重压缩命令（见 recompress.ts）与 OM 结果评估命令
 * （见 compaction-eval-command.ts）。压缩走工具驱动的压缩循环（模型经 getHistory /
 * compressHistory / completeCompression 工具完成，见 compress-loop.ts）；最终失败
 * （连续无工具调用 / 请求级错误）时拒绝本 step 中断当前 turn（signal 中止除外），
 * 主会话日志记录失败原因与诊断子会话 sessionId（完整循环会话由 compaction-log.ts
 * 落盘为子会话）。压缩与检索的实现见 compress.ts / compress-loop.ts /
 * compaction-log.ts / recall.ts / semantic-recall.ts。
 */
import type {} from '@deepseek-ai/cordis-plugin-loader';
import type {} from '@deepseek-ai/dsh-commands';
import { buildCompactionEvalCommand } from './compaction-eval-command.ts';
import { type CompressPassResult, maybeCompress } from './compress.ts';
import { Config, currentConfig } from './config.ts';
import { ensureModelReady, getEmbedder } from './embedding.ts';
import { makeLogger } from './logger.ts';
import { buildRecallTool } from './recall.ts';
import { buildRecompressCommand } from './recompress.ts';
import {
  activeSystemReminders,
  ensureSystemReminders,
  progressIdleOptions,
} from './system-reminder.ts';
import type { Context } from './types.ts';
import { isMainSession } from './utils.ts';

/** 插件名（Loader 识别入口的稳定标识）。 */
export const name = 'dsh-plugin-om';

export { Config };

/** 插件注入的服务依赖（tools/llm/tokenMeter/sessions），由宿主按序注入。 */
export const inject = ['tools', 'llm', 'tokenMeter', 'sessions'];

/** 插件激活入口：解析配置、注册工具、接线 pre-step 自动压缩与提醒补发。 */
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
  /** 当前已注册 recall 对应的语义增强开关与模型目录。 */
  let registered: { semantic: boolean; modelDir: string } | undefined;

  /** 保持注册的 recall 与当前配置一致；仅语义增强首次生效或更换目录时启动后台预热。 */
  function syncTools(): void {
    const next = currentConfig(config);
    const semantic = next.recallEnabled && next.semanticRecallEnabled;
    if (
      disposeRecall &&
      (!next.recallEnabled ||
        registered?.semantic !== semantic ||
        (semantic && registered.modelDir !== next.modelDir))
    ) {
      disposeRecall();
      disposeRecall = undefined;
      registered = undefined;
    }
    if (next.recallEnabled && !disposeRecall) {
      const directory = next.modelDir;
      disposeRecall = ctx.tools.register(
        buildRecallTool({
          getPruner: () => ctx.get('toolResultPruner'),
          ...(semantic
            ? {
                semantic: {
                  modelStatus: () => ensureModelReady(directory, warnModel, undefined, logModel),
                  embedder: (texts: readonly string[]) =>
                    getEmbedder(directory).then((embed) => embed(texts)),
                },
              }
            : {}),
        }),
      );
      registered = { semantic, modelDir: directory };
      if (semantic) void ensureModelReady(directory, warnModel, undefined, logModel);
    }
  }
  syncTools();
  ctx.on('loader/volatile-update', () => syncTools());

  // 压缩卡片的换模型重压缩入口：commands 服务可用时注册 /om-recompress，服务缺失则
  // 不注册（插件其余能力不受影响）。
  ctx.inject(['commands'], (inner) => {
    inner.effect(
      () => inner.commands.register(buildRecompressCommand(ctx, () => currentConfig(config))),
      'dsh-plugin-om: recompress command',
    );
    // OM 结果评估入口：新建同工作区会话，由它按随包发布的 compaction-eval 文档分析本会话
    inner.effect(
      () => inner.commands.register(buildCompactionEvalCommand(ctx)),
      'dsh-plugin-om: compaction eval command',
    );
  });

  // 两级自动压缩：pre-step 阻塞串行（先反思后观察）；仅主会话生效。
  // 压缩之后再确保提醒在消息列表中：被压缩遮蔽则补发。
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
    const decision = await next();
    // 压缩后按表层与待输入消息检查：进度提醒缺失或按活动窗口重发。
    const latest = currentConfig(config);
    const reminders = activeSystemReminders(latest);
    if (
      decision.kind === 'enter' &&
      !signal.aborted &&
      reminders.length > 0 &&
      isMainSession(agent.session)
    ) {
      return {
        ...decision,
        messages: ensureSystemReminders(
          agent.session,
          decision.messages,
          reminders,
          progressIdleOptions(latest),
        ),
      };
    }
    return decision;
  });
}
