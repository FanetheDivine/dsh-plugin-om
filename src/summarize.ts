/**
 * 摘要子会话（OM 观察/反思）：两级阈值下分别 fork 子会话——
 *  - observe：把「上下文中最后一次 <om-history> 之后」的未压缩消息压缩为观察日志
 *    （结果追加到旧摘要末尾，替换被压缩消息区间）；
 *  - reflect：把当前 <om-history> 精简合并（结果替换单个摘要节点）。
 *
 * 提示词不内嵌消息/摘要全文：fork 子会话继承父会话日志前缀（seed 截断于最后一个
 * turn/end，宿主 fork 提供方语义），按上下文中的 <om-history> 定位待处理部分；
 * message_id 对照表与中断标记由插件从日志计算后内嵌（id 非原文，保留关键 id 供
 * recall 检索）。摘要以工具调用为核心节点，不限于 run_code。
 * 仅主会话生效（index.ts 守卫）。
 */
import { HISTORY_TAG } from './constants.ts';
import type { Agent, Context, SubagentRun, SubagentStartRequest } from './types.ts';
import { blocksToText } from './utils.ts';

/** 观察者 persona：只针对未压缩消息产出观察日志，不用工具、不展示思考。 */
export const OBSERVER_PERSONA =
  '你是 dsh-plugin-om 的上下文观察者（Observer，机制参考 Mastra Observational Memory）：把会话中尚未压缩的消息压缩为一份观察日志。不用工具、不展示思考、不评价代码、不输出多余文字。';

/** 反思者 persona：只精简合并当前摘要，不用工具、不展示思考。 */
export const REFLECTOR_PERSONA =
  '你是 dsh-plugin-om 的上下文反思者（Reflector，机制参考 Mastra Observational Memory）：把当前 <om-history> 压缩日志精简合并为一份更紧凑的日志。不用工具、不展示思考、不输出多余文字。';

/** 观察提示词参数（对照表/中断标记由 compress.ts 从日志计算后传入）。 */
export type ObservePromptOptions = {
  /** message_id 对照表行（按序对应上下文中未压缩消息）。 */
  table: string[];
  /** 中断标记行（aborted/interrupted 轮次）。 */
  interruptions: string[];
  /** 是否存在旧摘要（决定「追加到上次产物末尾」的表述）。 */
  hasOldHistory: boolean;
};

/**
 * 构建观察提示词：规则（消息概括为要点 / 工具调用按目的聚合——不限于 run_code /
 * 仅关键消息保留 message_id / 中断标注 / 未完成写进度与下一步）+ message_id 对照表 +
 * 中断标记 + 追加说明。全文由继承上下文提供。
 */
export function buildObservePrompt(options: ObservePromptOptions): string {
  /** 对照表段落（无则标注「无」）。 */
  const tableSection = options.table.length > 0 ? options.table : ['（无）'];
  /** 中断标记段落（无则标注「无」）。 */
  const interruptionSection = options.interruptions.length > 0 ? options.interruptions : ['（无）'];
  return [
    `你继承的会话上下文中，最后一次 <${HISTORY_TAG}> 块之后的全部消息都是「未压缩消息」；只对这些消息做压缩，忽略更早的历史。`,
    `如果上下文里还没有 <${HISTORY_TAG}> 块，则除本消息外的全部消息都是未压缩消息。`,
    '',
    '【规则】',
    '- 用户消息概括为 user_message 条目（保留需求要点与关键事实：数字、路径、命令、决定），仅对关键消息保留 message_id（格式：user_message message_id:<id> text:<要点>）。关键消息指开启新任务/提出需求的请求、包含关键决策或不可再得事实的输入；普通消息（寒暄、重复、可推断内容）可以省略 message_id。',
    '- 所有工具调用（run_code 与其他工具同等对待，不限于 run_code）按调用目的聚合为一行 toolcall message_id:<该组最后一条消息的 message_id> purpose:<聚合目的> summary:<行为与结果摘要>；工具组内部细节（参数、完整输出）不保留，需要原文时用 recall 按 message_id 回看。',
    '- 若【中断标记】非空，在对应位置明确写出中断（例如「被用户打断，因此上一段工作未完成」），帮助后续理解用户为何再次输入消息、为何不延续之前的工作。',
    '- 若当前工作看起来未完成（最后一次工具调用没有结果、或对话被中断/异常结束），在日志末尾说明当前进度与下一步要做什么。',
    `- 只输出日志条目本身；不要 <${HISTORY_TAG}> 标签、不要解释、不要复述规则。`,
    '',
    '【message_id 对照表】（按顺序对应你上下文中的消息，用于产出正确的 message_id）',
    ...tableSection,
    '',
    '【中断标记】',
    ...interruptionSection,
    '',
    ...(options.hasOldHistory
      ? [
          `【说明】你的压缩结果会被直接追加到上一次压缩产物（<${HISTORY_TAG}>）的末尾，条目格式须与上一条目保持一致。`,
        ]
      : [`【说明】你的压缩结果将成为第一条 <${HISTORY_TAG}> 压缩日志。`]),
  ].join('\n');
}

/** 构建反思提示词：精简合并当前 <om-history>；全文由继承上下文提供。 */
export function buildReflectPrompt(): string {
  return [
    `你继承的会话上下文中包含当前的 <${HISTORY_TAG}> 压缩日志（最后一次 <${HISTORY_TAG}> 块）。`,
    '只对这份压缩日志做精简合并；不要涉及日志之外的消息。',
    '',
    '【规则】',
    '- 用户消息保留要点，仅保留关键 message_id（格式：user_message message_id:<id> text:<要点>）；可省略的 message_id 删除。',
    '- toolcall 条目按调用目的进一步聚合，保留组内最后一条消息的 message_id；不重要的条目 summary 写「（略）」。',
    '- 保留中断说明与未完成说明（若原日志中有）。',
    '- 过时事实丢弃，不逐字复制旧文本。',
    `- 只输出合并后的日志条目本身；不要 <${HISTORY_TAG}> 标签、不要解释、不要复述规则。`,
    '',
    `【说明】你的合并结果会替换当前的 <${HISTORY_TAG}> 块内容。`,
  ].join('\n');
}

/**
 * Fork 子会话执行一次摘要（观察或反思），返回文本；失败或无法 fork 返回 null。
 * 工具被 toolFilter 禁用，输出长度受 maxTokens 限制。
 */
export async function runSummarySubagent(
  ctx: Context,
  agent: Agent,
  persona: string,
  prompt: string,
  maxTokens: number,
  signal?: AbortSignal,
): Promise<string | null> {
  /** subagents 服务（缺失则无法分叉摘要）。 */
  const subagents = ctx.get('subagents');
  if (!subagents) {
    ctx.logger.warn('dsh-plugin-om: 未找到 subagents 服务，跳过摘要分叉');
    return null;
  }
  if (!subagents.getProvider('fork')) {
    ctx.logger.warn('dsh-plugin-om: fork 子代理提供方未注册，跳过摘要分叉');
    return null;
  }
  /** 本次 fork 运行的句柄（用于取结果与 dispose）。 */
  let run: SubagentRun | undefined;
  try {
    run = await subagents.start('fork', {
      label: 'om-summary',
      prompt: [{ type: 'text', text: prompt }],
      parent: agent,
      persona,
      toolFilter: { allow: [] }, // 禁用工具
      agentOptions: { maxTokens }, // 限制输出（含思考）长度
      ...(signal !== undefined ? { signal } : {}),
    } as SubagentStartRequest);
    /** 子代理运行结果。 */
    const result = await run.result;
    /** 输出块数组（取纯文本）。 */
    const output = Array.isArray(result.output) ? result.output : [];
    /** 拼接、去标签、去首尾空白的摘要文本。 */
    const text = blocksToText(output)
      .trim()
      .replace(new RegExp(`</?${HISTORY_TAG}>`, 'g'), '')
      .trim();
    if (result.stopReason !== 'completed' || text.length === 0) {
      ctx.logger.warn(
        'dsh-plugin-om: 摘要未完成（' +
          (result.stopReason === 'completed' ? '无输出' : String(result.stopReason)) +
          '），忽略本次摘要',
      );
      return null;
    }
    return text;
  } catch (error) {
    /** 错误信息（统一为字符串）。 */
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.warn(`dsh-plugin-om: 摘要子代理失败: ${message}，忽略`);
    return null;
  } finally {
    if (run && typeof run.dispose === 'function') {
      try {
        await run.dispose();
      } catch {
        /* dispose 失败忽略 */
      }
    }
  }
}
