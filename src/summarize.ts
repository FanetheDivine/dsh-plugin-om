/**
 * 摘要调用（OM 观察/反思）：直连 ctx.llm.stream()，由配置 summaryMode（环境变量
 * DSH_OM_SUMMARY_MODE）控制模式——
 *  - fork（缺省）：fork 会话风格——复用主会话请求前缀。system/tools 取自主会话
 *    requestHeader()，messages = 主会话完整派生历史 + 末尾追加一条指令 user 消息，
 *    使本次请求成为主会话上次请求的真前缀，充分利用 provider 前缀缓存
 *    （与宿主 compaction-basic 同款策略）；
 *  - new：新开会话风格——指令作为 system 提示词，被压缩消息（由 compress.ts 渲染传入）
 *    作为 user 消息输入模型压缩；
 *  - disable：关闭自动压缩（compress.ts 早退，不发起摘要调用）。
 *
 * 提示词不内嵌消息全文（fork 模式完整历史随请求传入；new 模式由 compress.ts 渲染
 * 区间传入）；message_id 对照表与中断标记由插件从日志计算后内嵌（id 非原文，保留关键 id
 * 供 recall 检索）。token usage 从流式响应的 usage chunk 提取，归入主会话记录。
 * 仅主会话生效（index.ts 守卫）。
 */

import type { FinishReason, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { SummaryMode } from './config.ts';
import { HISTORY_TAG, PLUGIN_LABEL } from './constants.ts';
import { messageIdOfEvent } from './log-index.ts';
import { makeLogger } from './logger.ts';
import type { Agent, Context, Session, TokenUsage, UserMessage } from './types.ts';
import { type RoutedTarget, renderMessageText, uuid } from './utils.ts';

/** 观察者 persona：只针对未压缩消息产出观察日志，不用工具、不展示思考。 */
export const OBSERVER_PERSONA =
  '你是 dsh-plugin-om 的上下文观察者（Observer，机制参考 Mastra Observational Memory）：把会话中尚未压缩的消息压缩为一份观察日志。不用工具、不展示思考、不评价代码、不输出多余文字。';

/** 反思者 persona：只精简合并当前摘要，不用工具、不展示思考。 */
export const REFLECTOR_PERSONA =
  '你是 dsh-plugin-om 的上下文反思者（Reflector，机制参考 Mastra Observational Memory）：把当前 <om-history> 压缩日志精简合并为一份更紧凑的日志。不用工具、不展示思考、不输出多余文字。';

/** 观察提示词参数（对照表/中断标记由 compress.ts 从日志计算后传入）。 */
export type ObservePromptOptions = {
  /** message_id 对照表行（按序对应消息记录中的未压缩消息）。 */
  table: string[];
  /** 中断标记行（aborted/interrupted 轮次）。 */
  interruptions: string[];
  /** 是否存在旧摘要（决定「追加到上次产物末尾」的表述）。 */
  hasOldHistory: boolean;
  /** 参考尾部条数（尾部保留的未压缩消息，不压缩、不进日志）。 */
  tailCount: number;
  /** 摘要模式：fork=完整历史随请求传入；new=被压缩消息渲染为输入。 */
  mode: SummaryMode;
};

/**
 * 构建观察指令主体：任务声明（fork：停止任务/禁止工具；new：说明总结日志）+ 模式相关
 * 的上下文定位与压缩范围（fork：上方完整会话记录、范围止于尾部之前；new：下方消息即
 * 压缩对象）+ 规则（用户消息完整保留原文 / AI 消息模块化压缩——工具调用按目的聚合——
 * 不限于 run_code / 倾向于新消息 / 中断标注 / 未完成写进度与下一步）+ 输出格式（合法
 * XML）+ 对照表 + 中断标记 + 追加说明。persona 由调用方拼接到指令开头。
 */
export function buildObservePrompt(options: ObservePromptOptions): string {
  /** 对照表段落（无则标注「无」）。 */
  const tableSection = options.table.length > 0 ? options.table : ['（无）'];
  /** 中断标记段落（无则标注「无」）。 */
  const interruptionSection = options.interruptions.length > 0 ? options.interruptions : ['（无）'];
  /** 任务声明：fork 会话可见完整上下文（可能处于任务中途），须停止任务并禁止工具；new 会话说明总结日志即可。 */
  const declaration =
    options.mode === 'fork'
      ? '停止一切现有任务，禁止调用任何工具，改为将过往消息总结为一份日志。'
      : '将过往消息总结为一份日志。';
  /** 上下文定位与压缩范围（按模式区分输入结构）。 */
  const framing =
    options.mode === 'fork'
      ? [
          '上方的消息记录是主会话的完整历史（系统提示词与全部消息）。',
          `总结范围：最后一次 <${HISTORY_TAG}> 块之后、最近 ${options.tailCount} 条消息之前的全部消息；最近 ${options.tailCount} 条消息（尾部）不压缩、不进日志。`,
          `如果消息记录里还没有 <${HISTORY_TAG}> 块，则除本指令外的全部消息（尾部除外）都是压缩对象。`,
        ]
      : [
          '下方的消息记录是本次要压缩的全部消息（上一个 <om-history> 块之后的新消息；不含旧压缩日志、不含尾部）。',
          '你的压缩结果会作为新的 <om-history> 块追加到已有压缩日志之后。',
        ];
  return [
    declaration,
    '',
    ...framing,
    '',
    '【规则】',
    '- 用户消息完整保留原文，输出为 <user_message> 条目（id 为该消息的 message_id，内容为消息原文，不概括、不省略）。',
    '- AI 消息划分模块压缩（与现状一致）：所有工具调用（run_code 与其他工具同等对待，不限于 run_code）按调用目的聚合为一行 toolcall message_id:<该组最后一条消息的 message_id> purpose:<聚合目的> summary:<行为与结果摘要>；目的相同、关联度高的连续行为聚合为一个 <assistant> 模块，模块内最后一条消息的 message_id 作为 last_id；工具组内部细节（参数、完整输出）不保留，需要原文时用 recall 按 message_id 回看。',
    '- 总结时倾向于新消息，旧消息一句话带过即可；新旧消息冲突时强调新消息，不修改旧日志条目。',
    '- 若【中断标记】非空，在对应位置明确写出中断（例如「被用户打断，因此上一段工作未完成」），帮助后续理解用户为何再次输入消息、为何不延续之前的工作。',
    '- 若当前工作看起来未完成（最后一次工具调用没有结果、或对话被中断/异常结束），在日志末尾说明当前进度与下一步要做什么。',
    '【输出格式】只输出一个 <om-history> 包裹的合法 XML 日志块，不要解释、不要复述规则：',
    `<${HISTORY_TAG}>`,
    '<user_message id="(message_id)">',
    '(user 消息原文)',
    '</user_message>',
    '<assistant last_id="(该组最后一条消息的 message_id)">',
    '(压缩模块：toolcall 聚合行等，与现有格式一致)',
    '</assistant>',
    `</${HISTORY_TAG}>`,
    '',
    '【message_id 对照表】（按顺序对应消息记录中的未压缩消息，用于产出正确的 message_id）',
    ...tableSection,
    '',
    '【中断标记】',
    ...interruptionSection,
    '',
    ...(options.hasOldHistory
      ? [
          `【说明】你的压缩结果会被直接追加到上一次压缩产物（<${HISTORY_TAG}>）的末尾，作为新的 <${HISTORY_TAG}> 块；条目格式与本块一致。`,
        ]
      : [`【说明】你的压缩结果将成为第一条 <${HISTORY_TAG}> 压缩日志。`]),
  ].join('\n');
}

/** 构建反思指令主体：任务声明（fork：停止任务/禁止工具；new：说明总结日志）+ 精简合并
 * 当前 <om-history> 的规则 + 输出格式（合法 XML）；消息记录全文由请求（fork）或渲染输入（new）提供。 */
export function buildReflectPrompt(mode: SummaryMode): string {
  /** 任务声明：fork 会话可见完整上下文，须停止任务并禁止工具；new 会话说明总结日志即可。 */
  const declaration =
    mode === 'fork'
      ? '停止一切现有任务，禁止调用任何工具，改为将当前压缩日志精简合并为一份更紧凑的日志。'
      : '将当前压缩日志精简合并为一份更紧凑的日志。';
  /** 上下文定位说明（按模式区分输入结构）。 */
  const framing =
    mode === 'new'
      ? [
          '下方的消息记录包含当前的 <om-history> 压缩日志（最后一次 <om-history> 块）。',
          '只对这份压缩日志做精简合并；不要涉及日志之外的消息。',
        ]
      : [
          '上方的消息记录是主会话的完整历史，其中包含当前的 <om-history> 压缩日志（最后一次 <om-history> 块）。',
          '只对这份压缩日志做精简合并；不要涉及日志之外的消息。',
        ];
  return [
    declaration,
    '',
    ...framing,
    '',
    '【规则】',
    '- 用户消息保留要点与 message_id（格式：<user_message id="(message_id)"> 要点 </user_message>）；可省略的条目删除。',
    '- toolcall 条目按调用目的进一步聚合，保留组内最后一条消息的 message_id；不重要的条目 summary 写「（略）」。',
    '- 保留中断说明与未完成说明（若原日志中有）。',
    '- 过时事实丢弃，不逐字复制旧文本；新旧条目冲突时保留新条目。',
    '【输出格式】只输出一个 <om-history> 包裹的合法 XML 日志块，不要解释、不要复述规则：',
    `<${HISTORY_TAG}>`,
    '<user_message id="(message_id)">',
    '(user 消息要点)',
    '</user_message>',
    '<assistant last_id="(该组最后一条消息的 message_id)">',
    '(压缩模块：toolcall 聚合行等，与现有格式一致)',
    '</assistant>',
    `</${HISTORY_TAG}>`,
    '',
    `【说明】你的合并结果会替换当前的 <${HISTORY_TAG}> 块内容。`,
  ].join('\n');
}

/**
 * 摘要调用结果：文本 + 可选 token usage（摘要请求自身消耗，随 compaction/summary
 * 归入主会话记录）。
 */
export type SummarySubagentResult = {
  text: string;
  usage?: TokenUsage;
};

/** 流收集器：提取文本输出 + usage + finish（不依赖宿主 BlockAssembler，保持零运行时依赖）。 */
class StreamCollector {
  /** 文本输出缓冲（text-delta 拼接；reasoning 不计入）。 */
  private textBuf = '';
  /** usage chunk（无则 undefined）。 */
  private _usage: TokenUsage | undefined;
  /** finish chunk（流结束仍无则视为 stop）。 */
  private _finish: FinishReason | undefined;

  /** 喂入一个流 chunk（仅消费文本/usage/finish，其余忽略）。 */
  push(chunk: StreamChunk): void {
    switch (chunk.type) {
      case 'text-delta':
        this.textBuf += chunk.text;
        break;
      case 'usage':
        this._usage = chunk.usage;
        break;
      case 'finish':
        this._finish = chunk.reason;
        break;
      default:
        break;
    }
  }

  /** 拼接后的文本输出。 */
  get text(): string {
    return this.textBuf;
  }

  /** 摘要 token usage（无则 undefined）。 */
  get usage(): TokenUsage | undefined {
    return this._usage;
  }

  /** 终止原因（流未给出 finish 时视为 stop）。 */
  get finish(): FinishReason {
    return this._finish ?? { kind: 'stop' };
  }
}

/**
 * 渲染表层消息记录（new 模式输入）：按表层顺序分组为合法 XML——
 *  - 用户消息 → <user_message id="(message_id)">(原文)</user_message>；
 *  - 连续 AI 消息（assistant/message 与其后的 tool/result）聚合为一个
 *    <assistant last_id="(组内最后一条消息的 message_id)">(各消息文本)</assistant>。
 * 组内文本沿用 role 头 + message_id + 文本（tool-call 展开参数、tool-result 取文本）。
 */
export function renderMessages(session: Session, seqs: readonly number[]): string {
  /** 渲染段缓冲区。 */
  const parts: string[] = [];
  /** 当前 assistant 组（组内消息文本行 + 最后一条消息 id）。 */
  let group: { lines: string[]; lastId: string | undefined } | undefined;
  /** 结束当前 assistant 组并输出 <assistant> 块。 */
  const flush = () => {
    if (!group || group.lines.length === 0) return;
    /** last_id 属性（组内最后一条消息 id；缺失/空串则省略）。 */
    const lastAttr = group.lastId ? ` last_id="${group.lastId}"` : '';
    parts.push(`<assistant${lastAttr}>\n${group.lines.join('\n')}\n</assistant>`);
    group = undefined;
  };
  for (const seq of seqs) {
    /** 当前待渲染事件。 */
    const event = session.events[seq];
    if (!event) continue;
    /** 消息 id（缺失则省略）。 */
    const id = messageIdOfEvent(event);
    /** 消息文本呈现。 */
    const text = renderMessageText(session.deriveEventMessage(event));
    if (event.type === 'user/message') {
      flush();
      /** id 属性（缺失/空串则省略）。 */
      const idAttr = id ? ` id="${id}"` : '';
      parts.push(`<user_message${idAttr}>\n${text}\n</user_message>`);
    } else if (event.type === 'assistant/message' || event.type === 'tool/result') {
      if (!group) group = { lines: [], lastId: undefined };
      /** role 标签（tool/result 属 user 角色但标注为工具结果）。 */
      const role = event.type === 'assistant/message' ? 'assistant' : 'tool/result';
      group.lines.push(`--- ${role}${id ? ` message_id=${id}` : ''} ---\n${text}`);
      if (id) group.lastId = id;
    }
  }
  flush();
  return parts.join('\n\n');
}

/** 构造插件自产 user 消息（指令或 system 模式的输入消息；id 为品牌类型 MessageId）。 */
function makePluginUserMessage(text: string): UserMessage {
  return {
    id: uuid() as unknown as UserMessage['id'],
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: PLUGIN_LABEL },
  } as unknown as UserMessage;
}

/**
 * 构建摘要请求选项：
 *  - prefix：system/tools 取自主会话 requestHeader()，messages = 完整派生历史 + 指令 user 消息；
 *  - system：system = 指令，messages = 渲染输入（被压缩消息 + 参考尾部）user 消息。
 */
function buildSummaryOptions(
  session: Session,
  instruction: string,
  contextText: string | undefined,
  maxTokens: number,
  mode: SummaryMode,
  target: RoutedTarget,
  signal: AbortSignal | undefined,
): GenerateOptions {
  /** 公共请求字段（provider/model/输出上限/会话归属/用途/取消）。 */
  const base = {
    provider: target.provider,
    model: target.model,
    maxTokens,
    sessionId: session.id,
    purpose: 'compaction' as const,
    ...(signal === undefined ? {} : { signal }),
  };
  if (mode === 'new') {
    return {
      ...base,
      system: instruction,
      messages: [makePluginUserMessage(contextText ?? '')],
    };
  }
  /** 主会话上次请求的请求头（system/tools 前缀对齐；无则省略）。 */
  const header = session.requestHeader();
  return {
    ...base,
    ...(header?.system === undefined ? {} : { system: header.system }),
    ...(header?.tools === undefined ? {} : { tools: [...header.tools] }),
    messages: [...session.deriveMessages(), makePluginUserMessage(instruction)],
  };
}

/** 单次摘要最多尝试次数（首次 + 失败重试，总上限；失败/未完成均重试）。 */
export const SUMMARY_MAX_ATTEMPTS = 3;

/** 尝试失败的简短原因（供重试日志与最终失败日志使用）。 */
type AttemptFailure = { error?: string; finish?: string };

/**
 * 直连 LLM 执行一次摘要（观察或反思），返回文本与可选 token usage。
 * 失败（抛异常 / 空输出 / 非 stop 结束）均记录日志并重试，总共最多尝试
 * SUMMARY_MAX_ATTEMPTS 次；全部尝试失败返回 null（不产生任何日志变更）。
 * 输出长度受 maxTokens 限制。
 */
export async function runSummarySubagent(
  ctx: Context,
  agent: Agent,
  instruction: string,
  contextText: string | undefined,
  maxTokens: number,
  mode: SummaryMode,
  target: RoutedTarget,
  signal?: AbortSignal,
): Promise<SummarySubagentResult | null> {
  /** 当前会话。 */
  const session = agent.session;
  /** 插件日志门面（失败日志始终输出）。 */
  const logger = makeLogger(ctx);
  /** 最后一次失败的原因（error=调用异常 / finish=未完成原因；最终失败日志使用）。 */
  let lastFailure: AttemptFailure = {};
  for (let attempt = 1; attempt <= SUMMARY_MAX_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) {
      logger.warn(
        `摘要调用中止（第 ${attempt}/${SUMMARY_MAX_ATTEMPTS} 次尝试前 signal 已中止），放弃本次摘要`,
      );
      return null;
    }
    logger.step(
      `摘要调用开始（第 ${attempt}/${SUMMARY_MAX_ATTEMPTS} 次，模式 ${mode}，provider ${target.provider}，model ${target.model}，maxTokens ${maxTokens}）`,
    );
    try {
      /** 摘要请求选项（按模式组装）。 */
      const options = buildSummaryOptions(
        session,
        instruction,
        contextText,
        maxTokens,
        mode,
        target,
        signal,
      );
      /** 流收集器（文本/usage/finish）。 */
      const collector = new StreamCollector();
      for await (const chunk of ctx.llm.stream(options)) collector.push(chunk);
      /** 拼接、去标签、去首尾空白的摘要文本。 */
      const text = collector.text
        .trim()
        .replace(new RegExp(`</?${HISTORY_TAG}>`, 'g'), '')
        .trim();
      /** 终止原因（仅 stop 视为完成）。 */
      const finish = collector.finish;
      if (finish.kind !== 'stop' || text.length === 0) {
        /** 未完成原因（空输出 / 非 stop 终止原因）。 */
        const reason = finish.kind === 'stop' ? '无输出' : String(finish.kind);
        lastFailure = { finish: reason };
        logger.warn(
          `摘要未完成（第 ${attempt}/${SUMMARY_MAX_ATTEMPTS} 次，${reason}）` +
            (attempt < SUMMARY_MAX_ATTEMPTS ? '，将重试' : '，重试耗尽，忽略本次摘要'),
        );
        continue;
      }
      /** 摘要请求的 token usage（归入主会话记录；无则省略）。 */
      const usage = collector.usage;
      logger.step(
        `摘要调用成功（第 ${attempt}/${SUMMARY_MAX_ATTEMPTS} 次，输出 ${text.length} 字符` +
          (usage === undefined
            ? ''
            : `，input ${String(usage.inputTokens ?? '?')} / output ${String(usage.outputTokens ?? '?')} tokens`) +
          '）',
      );
      return { text, ...(usage === undefined ? {} : { usage }) };
    } catch (error) {
      /** 错误信息（统一为字符串）。 */
      const message = error instanceof Error ? error.message : String(error);
      lastFailure = { error: message };
      logger.warn(
        `摘要调用失败（第 ${attempt}/${SUMMARY_MAX_ATTEMPTS} 次，${message}）` +
          (attempt < SUMMARY_MAX_ATTEMPTS ? '，将重试' : '，重试耗尽，忽略本次摘要'),
      );
    }
  }
  /** 全部尝试失败：记录最终失败日志（含最后原因，便于诊断）。 */
  logger.warn(
    `摘要调用最终失败（已尝试 ${SUMMARY_MAX_ATTEMPTS} 次` +
      (lastFailure.error !== undefined ? `，最后错误：${lastFailure.error}` : '') +
      (lastFailure.finish !== undefined ? `，最后结果：${lastFailure.finish}` : '') +
      '），忽略本次摘要',
  );
  return null;
}
