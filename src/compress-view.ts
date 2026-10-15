/**
 * 压缩视图：把被压缩区间投影为统一的条目序列（ViewEntry）。
 * 观察视图由完整消息原文构建（buildObserveView），反思视图由已有 <history> 块内条目构建
 * （buildReflectView）；getHistory 查看、compressHistory 区间校验与最终 <history> 块构建
 * 共用同一套条目。导出 AskUserQuestionView / ViewEntry / CompressionView / BuildViewOptions / buildObserveView /
 * buildReflectView / renderEntriesXml / entryToElement / appendCdataText / historyInner /
 * toolCallNameOf / skillNameOf。
 */

import type { Document, Element, Node } from '@xmldom/xmldom';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { z } from 'zod';
import { ASK_USER_QUESTION_TOOL_NAME, HISTORY_TAG, SKILL_TOOL_NAME } from './constants.ts';
import {
  indexCompleteMessages,
  renderCompleteMessage,
  renderToolResultText,
  toolCallBlockOf,
  toolResultMessageOf,
} from './log-index.ts';
import type { CompleteMessage, Session } from './types.ts';
import { appendCdataText, isRecord, renderMessageText, toolArgsJson } from './utils.ts';

/** 合法原始 ask 的逐题数据，选项仅用于观察视图。 */
export type AskUserQuestionView = {
  /** 按调用参数题序排列的问答。 */
  questions: {
    /** 原始问题文本。 */
    question: string;
    /** 选项文本和说明。 */
    options: { label: string; description?: string }[];
    /** 已配对的回答，空答记为未回答。 */
    answer: string;
  }[];
};

/**
 * 视图条目：压缩区间内一条可定位的内容单位。
 * - user 条目不可压缩（compressHistory 覆盖时报错），构建最终块时原样保留
 * - assistant 条目可压缩（观察视图为模型文本或工具调用原文，反思视图为块内摘要）
 * - reasoning 条目仅作参考，不进最终产物
 * - lo/hi 缺失的 assistant 条目为不可定位的历史遗留块（整块无法解析时降级保留）
 */
export type ViewEntry = {
  /** 条目类别。 */
  kind: 'user' | 'assistant' | 'reasoning';
  /** 覆盖区间下界（完整消息 index；reasoning 与历史遗留条目无）。 */
  lo?: number;
  /** 覆盖区间上界（单条 = lo；reasoning 与历史遗留条目无）。 */
  hi?: number;
  /** 条目文本（user 为文本块原文；assistant 为原文或摘要）。 */
  text: string;
  /** user 条目的非文本块注释（图片附件元信息等，渲染为 XML 注释）。 */
  notes?: string[];
  /** skill 条目的工具名（skill 判定用）或普通 toolcall 的工具名。 */
  toolName?: string;
  /** skill 条目的名称（工具参数提供；反思视图取自 name 属性）。 */
  skillName?: string;
  /** toolcall 条目的调用 id（结构化渲染为 callId 属性）。 */
  callId?: string;
  /** toolcall 条目的调用参数 JSON 文本（存在时条目渲染为 <assistant type="toolcall"> 结构）。 */
  toolArgs?: string;
  /** toolcall 条目的工具返回文本（缺失或为空时不输出 <tool-result> 子元素）。 */
  toolResult?: string;
  /** 合法原始 ask 的数据；已有 history 条目不设置。 */
  ask?: AskUserQuestionView;
  /** 所属压缩块 seq（反思视图；块整体展开以此分组）。 */
  blockSeq?: number;
};

/** 压缩视图：条目序列 + 要求区间（getHistory / compressHistory 的 index 合法范围）。 */
export type CompressionView = {
  /** 条目序列（按 index 顺序；reasoning 位于其所属 assistant 条目之前）。 */
  entries: ViewEntry[];
  /** 要求区间首 index（无任何可定位条目时 undefined）。 */
  minIndex?: number;
  /** 要求区间尾 index（无任何可定位条目时 undefined）。 */
  maxIndex?: number;
};

/** 静默 DOMParser：非致命解析问题不刷 console，fatalError 仍抛 ParseError、解析语义不变。 */
function newQuietParser(): DOMParser {
  return new DOMParser({ onError: () => {} });
}

/** 判定 DOM 节点为元素节点（nodeType 1；text/comment 等节点跳过）。 */
function isElement(node: Node | undefined): node is Element {
  return node?.nodeType === 1;
}

/**
 * 提取用户消息条目的文本与注释（文本块拼接为原文；图片/其他块降级为注释文本，
 * 渲染时输出为 XML 注释）。无任何内容返回 null（该 index 在视图中不占条目）。
 */
function userEntryParts(
  session: Session,
  cm: CompleteMessage,
): { text: string; notes: string[] } | null {
  const seq = cm.seqs[0];
  const event = seq === undefined ? undefined : session.snapshotEvents()[seq];
  const message = event ? session.deriveEventMessage(event) : null;
  if (!message || !Array.isArray(message.content)) return null;
  const texts: string[] = [];
  const notes: string[] = [];
  for (const block of message.content) {
    if (block.type === 'text') {
      texts.push(String(block.text));
    } else if (block.type === 'image') {
      const ref = block.attachment as
        | { name?: string; mediaType?: string; width?: number; height?: number; bytes?: number }
        | undefined;
      const name = ref?.name ? `：${ref.name}` : '';
      const meta = ref
        ? `（${String(ref.mediaType ?? '')} ${String(ref.width ?? '')}×${String(ref.height ?? '')}，${String(ref.bytes ?? '')} bytes）`
        : '';
      notes.push(` 图片附件${name}${meta} `);
    } else {
      notes.push(` ${String(block.type)} 块 `);
    }
  }
  if (texts.length === 0 && notes.length === 0) return null;
  return { text: texts.join('\n'), notes };
}

/**
 * 提取 toolcall 完整消息的工具名（按 callId 在所属 assistant 消息中定位 tool-call 块）。
 * 找不到返回 undefined。
 */
export function toolCallNameOf(session: Session, cm: CompleteMessage): string | undefined {
  if (cm.type !== 'toolcall') return undefined;
  const seq = cm.seqs[0];
  const event = seq === undefined ? undefined : session.snapshotEvents()[seq];
  if (event?.type !== 'assistant/message') return undefined;
  const message = event.data.message;
  if (!message || !Array.isArray(message.content)) return undefined;
  for (const block of message.content) {
    if (block.type === 'tool-call' && String(block.id ?? '') === (cm.callId ?? '')) {
      return String(block.name ?? '');
    }
  }
  return undefined;
}

/**
 * 提取 skill 条目的 skill 名（tool-call 参数 JSON 的 name 字段）。非 skill 工具的
 * toolcall 返回 undefined；toolName 为 skill 但参数缺失或非法时返回空串。
 */
export function skillNameOf(session: Session, cm: CompleteMessage): string | undefined {
  if (toolCallNameOf(session, cm) !== SKILL_TOOL_NAME) return undefined;
  const seq = cm.seqs[0];
  const event = seq === undefined ? undefined : session.snapshotEvents()[seq];
  if (event?.type !== 'assistant/message') return '';
  const message = event.data.message;
  if (!message || !Array.isArray(message.content)) return '';
  for (const block of message.content) {
    if (block.type === 'tool-call' && String(block.id ?? '') === (cm.callId ?? '')) {
      try {
        const args: unknown = JSON.parse(String(block.arguments ?? ''));
        if (isRecord(args) && typeof args.name === 'string') return args.name;
      } catch {
        // 参数非法时视为无名
      }
      return '';
    }
  }
  return '';
}

/** 未作答题目的呈现文本。 */
const ASK_UNANSWERED_TEXT = '(未回答)';

/** 提问参数的完整结构；非法项使整次调用回退。 */
const askQuestionsSchema = z.object({
  questions: z
    .array(
      z.object({
        id: z.string().refine((id) => id.trim() !== ''),
        question: z.string().refine((question) => question.trim() !== ''),
        options: z
          .array(z.object({ label: z.string(), description: z.string().optional() }))
          .optional(),
      }),
    )
    .min(1),
});

/** 回答结果的完整结构；等待和失败状态不是合法问答。 */
const askAnswersSchema = z.object({
  pending: z.literal(false).optional(),
  aborted: z.literal(false).optional(),
  isError: z.literal(false).optional(),
  error: z.never().optional(),
  answers: z.array(
    z.object({
      id: z.string().refine((id) => id.trim() !== ''),
      selected: z.array(z.string()),
      custom: z.string().optional(),
    }),
  ),
});

/** 校验配对成功的原始 ask，按题序保存问题、选项和回答。 */
function askUserQuestionData(session: Session, cm: CompleteMessage): AskUserQuestionView | null {
  const call = toolCallBlockOf(session, cm);
  const resultMessage = toolResultMessageOf(session, cm);
  if (!call || !resultMessage) return null;
  const resultSeq = cm.seqs[1];
  const resultEvent = resultSeq === undefined ? undefined : session.snapshotEvents()[resultSeq];
  if (resultEvent?.type !== 'tool/result' || resultEvent.data.error !== undefined) return null;
  if (
    resultMessage.role === 'tool' &&
    (resultMessage.isError || resultMessage.toolCallId !== cm.callId)
  )
    return null;
  if (
    resultMessage.content.some((block) => {
      const legacy = block as { type: string; isError?: boolean };
      return legacy.type === 'tool-result' && legacy.isError === true;
    })
  )
    return null;
  const args = toolArgsJson(call.arguments);
  const result = renderMessageText(resultMessage);
  try {
    const questions = askQuestionsSchema.safeParse(JSON.parse(args));
    const answers = askAnswersSchema.safeParse(JSON.parse(result));
    if (!questions.success || !answers.success) return null;
    const ids = new Set(questions.data.questions.map((question) => question.id));
    const answerMap = new Map(answers.data.answers.map((answer) => [answer.id, answer]));
    if (
      ids.size !== questions.data.questions.length ||
      answerMap.size !== answers.data.answers.length ||
      answerMap.size !== ids.size ||
      [...answerMap.keys()].some((id) => !ids.has(id))
    )
      return null;
    return {
      questions: questions.data.questions.map((question) => {
        const answer = answerMap.get(question.id);
        const text = answer
          ? [...answer.selected, ...(answer.custom ? [answer.custom] : [])].join(', ')
          : '';
        return {
          question: question.question,
          options: (question.options ?? []).map((option) => ({
            label: option.label,
            ...(option.description === undefined ? {} : { description: option.description }),
          })),
          answer: text === '' ? ASK_UNANSWERED_TEXT : text,
        };
      }),
    };
  } catch {
    return null;
  }
}

/** 观察 ask 正文：保留多行原文，每题按 q/options/a 呈现。 */
function askUserQuestionText(ask: AskUserQuestionView): string {
  return `<ask-user-question>${ask.questions
    .flatMap((question) => [
      `q:${question.question}`,
      ...question.options.map(
        (option, index) =>
          `o${index + 1}:${option.label}${option.description ? ` — ${option.description}` : ''}`,
      ),
      `a:${question.answer}`,
    ])
    .join('\n')}</ask-user-question>`;
}

/** 视图构建选项：skipReasoning=true 时不含 <reasoning> 参考条目。 */
export type BuildViewOptions = {
  /** 是否在视图中省略 reasoning 参考条目。 */
  skipReasoning?: boolean;
};

/**
 * 观察视图：被压缩区间（表层 seq 集合）内的完整消息投影为条目——
 * user → 原文（图片等非文本块为注释）、
 * assistant/toolcall → 原文渲染，reasoning 作为参考条目置于其所属 assistant 条目之前（每条 assistant 消息输出一次；
 * skipReasoning 时省略）。
 * 要求区间为区间内完整消息的首尾 index。
 */
export function buildObserveView(
  session: Session,
  seqs: readonly number[],
  options: BuildViewOptions = {},
): CompressionView {
  const shadowed = new Set(seqs);
  const reasoningBySeq = new Map<number, string[]>();
  for (const seq of seqs) {
    const event = session.snapshotEvents()[seq];
    if (event?.type !== 'assistant/message') continue;
    const message = event.data.message;
    if (!message || !Array.isArray(message.content)) continue;
    const reasonings: string[] = [];
    for (const block of message.content) {
      if (block.type === 'reasoning' && typeof block.text === 'string') reasonings.push(block.text);
    }
    if (reasonings.length > 0) reasoningBySeq.set(seq, reasonings);
  }
  const entries: ViewEntry[] = [];
  const emittedReasoning = new Set<number>();
  for (const cm of indexCompleteMessages(session)) {
    if (!cm.seqs.every((seq) => shadowed.has(seq))) continue;
    if (cm.type === 'user') {
      const parts = userEntryParts(session, cm);
      if (parts === null) continue;
      entries.push({
        kind: 'user',
        lo: cm.index,
        hi: cm.index,
        text: parts.text,
        ...(parts.notes.length === 0 ? {} : { notes: parts.notes }),
      });
      continue;
    }
    // assistant / toolcall 条目：先输出所属 assistant 消息的 reasoning（每条消息一次；skipReasoning 时省略）
    if (options.skipReasoning !== true) {
      const callSeq = cm.seqs[0];
      const reasonings = callSeq === undefined ? undefined : reasoningBySeq.get(callSeq);
      if (callSeq !== undefined && reasonings !== undefined && !emittedReasoning.has(callSeq)) {
        emittedReasoning.add(callSeq);
        for (const text of reasonings) {
          entries.push({ kind: 'reasoning', lo: cm.index, hi: cm.index, text });
        }
      }
    }
    const toolName = cm.type === 'toolcall' ? toolCallNameOf(session, cm) : undefined;
    const isSkill = toolName === SKILL_TOOL_NAME;
    const ask = toolName === ASK_USER_QUESTION_TOOL_NAME ? askUserQuestionData(session, cm) : null;
    const isAsk = ask !== null;
    // skill 保留返回内容；合法 ask 保留问答；其余调用保留完整参数和结果。
    const text = isSkill
      ? renderToolResultText(session, cm)
      : ask !== null
        ? askUserQuestionText(ask)
        : renderCompleteMessage(session, cm);
    if (text.trim() === '') continue;
    const skillName = isSkill ? skillNameOf(session, cm) : undefined;
    // 非 skill / ask_user_question 的 toolcall 条目提取调用参数与返回文本（渲染为 <assistant type="toolcall"> 结构）
    let toolArgs: string | undefined;
    let toolResult: string | undefined;
    if (cm.type === 'toolcall' && !isSkill && !isAsk) {
      const call = toolCallBlockOf(session, cm);
      if (call !== undefined) toolArgs = toolArgsJson(call.arguments);
      const resultMessage = toolResultMessageOf(session, cm);
      if (resultMessage && Array.isArray(resultMessage.content)) {
        toolResult = renderMessageText(resultMessage);
      }
    }
    entries.push({
      kind: 'assistant',
      lo: cm.index,
      hi: cm.index,
      text,
      ...(toolName === undefined ? {} : { toolName }),
      ...(skillName === undefined ? {} : { skillName }),
      ...(cm.callId === undefined || toolArgs === undefined ? {} : { callId: cm.callId }),
      ...(toolArgs === undefined ? {} : { toolArgs }),
      ...(toolResult === undefined ? {} : { toolResult }),
      ...(ask === null ? {} : { ask }),
    });
  }
  return { entries, ...viewBounds(entries) };
}

/** 提取视图要求区间：全部可定位条目的最小 lo 与最大 hi（无可定位条目时均 undefined）。 */
function viewBounds(entries: ViewEntry[]): { minIndex?: number; maxIndex?: number } {
  let minIndex: number | undefined;
  let maxIndex: number | undefined;
  for (const entry of entries) {
    if (entry.lo === undefined || entry.hi === undefined) continue;
    if (minIndex === undefined || entry.lo < minIndex) minIndex = entry.lo;
    if (maxIndex === undefined || entry.hi > maxIndex) maxIndex = entry.hi;
  }
  return {
    ...(minIndex === undefined ? {} : { minIndex }),
    ...(maxIndex === undefined ? {} : { maxIndex }),
  };
}

/** 提取 <history> 块的内文（去开/闭标签；非块文本原样返回）。 */
export function historyInner(text: string): string {
  const closeTag = `</${HISTORY_TAG}>`;
  const close = text.lastIndexOf(closeTag);
  if (close === -1) return text;
  const open = text.indexOf(`<${HISTORY_TAG}`);
  if (open === -1) return text;
  const gt = text.indexOf('>', open);
  if (gt === -1 || gt >= close) return text;
  return text.slice(gt + 1, close);
}

/** 读取元素整数属性（非负整数；缺失 / 非数字返回 undefined）。 */
function intAttr(el: Element, name: string): number | undefined {
  const raw = el.getAttribute(name);
  if (raw === null || raw === '') return undefined;
  if (!/^\d+$/.test(raw)) return undefined;
  return Number(raw);
}

/** 读取元素第一个指定名子元素的正文（缺失返回 undefined）。 */
function childText(el: Element, tag: string): string | undefined {
  const child = el.getElementsByTagName(tag)[0];
  return child === undefined ? undefined : (child.textContent ?? '');
}

/**
 * 提取 skill 工具返回内容（原生 <skill_content> 包裹）中 <skill_resources> 与
 * <skill_instructions> 两段正文。非该包裹形态、两段缺失或两段之间存在其他内容时
 * 返回 undefined（调用方回退为整体 CDATA 原文）。
 */
function skillContentSections(
  text: string,
): { resources: string; instructions: string } | undefined {
  const wrapper = /^[\s]*<skill_content\b[^>]*>([\s\S]*)<\/skill_content>[\s]*$/.exec(text);
  if (!wrapper) return undefined;
  const body = wrapper[1] ?? '';
  const match =
    /^([\s\S]*?)<skill_resources>([\s\S]*?)<\/skill_resources>([\s\S]*?)<skill_instructions>([\s\S]*?)<\/skill_instructions>([\s\S]*)$/.exec(
      body,
    );
  if (!match) return undefined;
  const before = match[1] ?? '';
  const resources = match[2] ?? '';
  const between = match[3] ?? '';
  const instructions = match[4] ?? '';
  const after = match[5] ?? '';
  if (before.trim() !== '' || between.trim() !== '' || after.trim() !== '') return undefined;
  return { resources, instructions };
}

/**
 * 提取新格式 ask_user_question 条目正文（原生 <ask-user-question> 包裹）的内文
 * （CDATA 内 q:/a: 成对行）。非该包裹形态时返回 undefined。
 */
function askUserQuestionInner(text: string): string | undefined {
  const wrapper = /^[\s]*<ask-user-question\b[^>]*>([\s\S]*)<\/ask-user-question>[\s]*$/.exec(text);
  return wrapper?.[1];
}

/**
 * 提取旧格式 ask_user_question 条目正文（原生 <askuserquestion> 包裹）的内文。
 * 非该包裹形态时返回 undefined。
 */
function askUserQuestionLegacyInner(text: string): string | undefined {
  const wrapper = /^[\s]*<askuserquestion\b[^>]*>([\s\S]*)<\/askuserquestion>[\s]*$/.exec(text);
  return wrapper?.[1];
}

/**
 * 提取旧格式 ask_user_question 条目正文（原生 <askuserquestion> 包裹）中
 * <questions> 与 <answers> 两段正文。<questions> 与 <answers> 均缺失、两段之间存在
 * 其他内容时返回 undefined（调用方按旧格式整体正文处理）；<answers> 缺省为
 * undefined（渲染时省略该段）。
 */
function askUserQuestionSections(
  text: string,
): { questions: string; answers?: string } | undefined {
  const body = askUserQuestionLegacyInner(text);
  if (body === undefined) return undefined;
  const qMatch = /<questions>([\s\S]*?)<\/questions>/.exec(body);
  const aMatch = /<answers>([\s\S]*?)<\/answers>/.exec(body);
  if (!qMatch && !aMatch) return undefined;
  if (qMatch && aMatch && aMatch.index < qMatch.index) return undefined;
  let rest = body;
  if (qMatch) rest = rest.replace(qMatch[0], '');
  if (aMatch) rest = rest.replace(aMatch[0], '');
  if (rest.trim() !== '') return undefined;
  return {
    questions: qMatch?.[1] ?? '',
    ...(aMatch === null ? {} : { answers: aMatch[1] ?? '' }),
  };
}

/**
 * 向元素追加 CDATA 正文（实现在 utils.ts，此处再导出保持既有导入路径）。
 */
export { appendCdataText } from './utils.ts';

/**
 * 解析一个已有 <history> 块的内条目（反思视图）：user_message / assistant
 * （index 单条或 start/end 区间）/ skill_content（name 属性 + index 定位）/
 * ask-user-question（index 定位）/ reasoning；其余标签（含旧版 sys）一律忽略。
 * 整块无法解析或根非 <history> 时降级为单条不可定位的历史遗留条目（text 为块内文原文，
 * 构建最终块时原样保留）。
 */
function parseBlockEntries(blockText: string, blockSeq: number): ViewEntry[] {
  const opaque = (): ViewEntry[] => [
    { kind: 'assistant', text: historyInner(blockText), blockSeq },
  ];
  let doc: Document;
  try {
    doc = newQuietParser().parseFromString(blockText, 'text/xml');
  } catch {
    return opaque();
  }
  const root = doc.documentElement;
  if (!root || root.nodeName !== HISTORY_TAG) return opaque();
  const entries: ViewEntry[] = [];
  const children = root.childNodes;
  for (let i = 0; i < children.length; i += 1) {
    const el = children[i];
    if (!isElement(el)) continue;
    const text = el.textContent ?? '';
    if (el.nodeName === 'user_message') {
      const index = intAttr(el, 'index');
      if (index === undefined) continue;
      entries.push({ kind: 'user', lo: index, hi: index, text, blockSeq });
    } else if (el.nodeName === 'assistant') {
      const index = intAttr(el, 'index');
      if (index !== undefined) {
        const toolArgs = childText(el, 'tool-args');
        if (toolArgs !== undefined) {
          // 结构化 toolcall 条目：调用参数与返回内容各自成子元素，重新渲染时保持结构
          const toolResult = childText(el, 'tool-result');
          const toolName = el.getAttribute('tool-name');
          const callId = el.getAttribute('callId');
          entries.push({
            kind: 'assistant',
            lo: index,
            hi: index,
            text,
            ...(toolName === null || toolName === '' ? {} : { toolName }),
            ...(callId === null || callId === '' ? {} : { callId }),
            toolArgs,
            ...(toolResult === undefined ? {} : { toolResult }),
            blockSeq,
          });
          continue;
        }
        entries.push({ kind: 'assistant', lo: index, hi: index, text, blockSeq });
        continue;
      }
      const start = intAttr(el, 'start');
      const end = intAttr(el, 'end');
      if (start !== undefined && end !== undefined) {
        entries.push({ kind: 'assistant', lo: start, hi: end, text, blockSeq });
      }
      // 属性缺失的 assistant 条目跳过（防御：产物块创建时已校验属性）
    } else if (el.nodeName === 'skill_content') {
      const index = intAttr(el, 'index');
      if (index !== undefined) {
        const name = el.getAttribute('name');
        const resources = childText(el, 'skill_resources');
        const instructions = childText(el, 'skill_instructions');
        const text =
          resources !== undefined && instructions !== undefined
            ? `<skill_content${name === null ? '' : ` name="${name}"`}>` +
              `<skill_resources>${resources}</skill_resources>` +
              `<skill_instructions>${instructions}</skill_instructions></skill_content>`
            : (el.textContent ?? '');
        entries.push({
          kind: 'assistant',
          lo: index,
          hi: index,
          text,
          toolName: SKILL_TOOL_NAME,
          ...(name === null ? {} : { skillName: name }),
          blockSeq,
        });
      }
      // 属性缺失的 skill_content 条目跳过（防御：产物块创建时已校验属性）
    } else if (el.nodeName === 'ask-user-question') {
      const index = intAttr(el, 'index');
      if (index !== undefined) {
        // 还原为原生 ask-user-question 包裹形态（CDATA 内为 q:/a: 行）
        entries.push({
          kind: 'assistant',
          lo: index,
          hi: index,
          text: `<ask-user-question>${el.textContent ?? ''}</ask-user-question>`,
          toolName: ASK_USER_QUESTION_TOOL_NAME,
          blockSeq,
        });
      }
      // 属性缺失的 ask-user-question 条目跳过（防御：产物块创建时已校验属性）
    } else if (el.nodeName === 'askuserquestion') {
      const index = intAttr(el, 'index');
      if (index !== undefined) {
        const questions = childText(el, 'questions');
        const answers = childText(el, 'answers');
        // 两段子元素齐备时还原为原生 askuserquestion 包裹形态（供渲染时按两段拆分）；
        // 其余内文同样以旧格式包裹形态保留（渲染时保持旧格式原样）
        const text =
          questions !== undefined || answers !== undefined
            ? '<askuserquestion>' +
              (questions === undefined ? '' : `<questions>${questions}</questions>`) +
              (answers === undefined ? '' : `<answers>${answers}</answers>`) +
              '</askuserquestion>'
            : `<askuserquestion>${el.textContent ?? ''}</askuserquestion>`;
        entries.push({
          kind: 'assistant',
          lo: index,
          hi: index,
          text,
          toolName: ASK_USER_QUESTION_TOOL_NAME,
          blockSeq,
        });
      }
      // 属性缺失的 askuserquestion 条目跳过（防御：产物块创建时已校验属性）
    } else if (el.nodeName === 'reasoning') {
      entries.push({ kind: 'reasoning', text, blockSeq });
    }
  }
  if (entries.length === 0) return opaque();
  return entries;
}

/**
 * 反思视图：全部 <history> 块（historySection 收集，按表层顺序）的内条目投影为条目。
 * 要求区间为全部块内条目引用的最小 / 最大 index；块解析失败降级为不可定位遗留条目；
 * skipReasoning 时不含 <reasoning> 参考条目。
 */
export function buildReflectView(
  blocks: Array<{ text: string; seq: number }>,
  options: BuildViewOptions = {},
): CompressionView {
  const entries: ViewEntry[] = [];
  for (const block of blocks) {
    entries.push(...parseBlockEntries(block.text, block.seq));
  }
  const filtered =
    options.skipReasoning === true
      ? entries.filter((entry) => entry.kind !== 'reasoning')
      : entries;
  return { entries: filtered, ...viewBounds(filtered) };
}

/**
 * 把一个视图条目构建为 XML 元素（正文统一以 CDATA 包裹，逐字原样；user 条目的注释
 * 输出为 XML 注释节点）。getHistory 输出与
 * 最终 <history> 块共用。
 */
export function entryToElement(doc: Document, entry: ViewEntry): Element {
  if (entry.kind === 'user') {
    const el = doc.createElement('user_message');
    if (entry.lo !== undefined) el.setAttribute('index', String(entry.lo));
    appendCdataText(doc, el, entry.text);
    for (const note of entry.notes ?? []) el.appendChild(doc.createComment(note));
    return el;
  }
  if (entry.kind === 'reasoning') {
    const el = doc.createElement('reasoning');
    appendCdataText(doc, el, entry.text);
    return el;
  }
  if (
    entry.kind === 'assistant' &&
    entry.toolArgs !== undefined &&
    entry.lo !== undefined &&
    entry.hi !== undefined &&
    entry.lo === entry.hi
  ) {
    // toolcall 条目：<assistant type="toolcall" tool-name callId index>，内文为
    // <tool-args>（调用参数 JSON）与 <tool-result>（工具返回内容）两个 CDATA 子元素，
    // 与 recall 的条目形态一致。
    const el = doc.createElement('assistant');
    el.setAttribute('index', String(entry.lo));
    el.setAttribute('type', 'toolcall');
    if (entry.toolName !== undefined && entry.toolName !== '') {
      el.setAttribute('tool-name', entry.toolName);
    }
    if (entry.callId !== undefined && entry.callId !== '') {
      el.setAttribute('callId', entry.callId);
    }
    const args = doc.createElement('tool-args');
    appendCdataText(doc, args, entry.toolArgs);
    el.appendChild(args);
    if (entry.toolResult !== undefined && entry.toolResult.trim() !== '') {
      const result = doc.createElement('tool-result');
      appendCdataText(doc, result, entry.toolResult);
      el.appendChild(result);
    }
    return el;
  }
  if (entry.kind === 'assistant' && entry.ask !== undefined) {
    const el = doc.createElement('ask-user-question');
    if (entry.lo !== undefined && entry.lo === entry.hi) el.setAttribute('index', String(entry.lo));
    appendCdataText(doc, el, askUserQuestionInner(askUserQuestionText(entry.ask)) ?? '');
    return el;
  }
  if (entry.kind === 'assistant' && entry.toolName === ASK_USER_QUESTION_TOOL_NAME) {
    // ask_user_question 条目：<ask-user-question index="N">，CDATA 内为 q:（问题文本）
    // 与 a:（用户回答）成对的行；旧格式 <askuserquestion> 包裹形态原样保留；两种包裹形态
    // 均不匹配时回退整体 CDATA 原文。
    const inner = askUserQuestionInner(entry.text);
    if (inner !== undefined) {
      const el = doc.createElement('ask-user-question');
      if (entry.lo !== undefined && entry.lo === entry.hi) {
        el.setAttribute('index', String(entry.lo));
      }
      appendCdataText(doc, el, inner);
      return el;
    }
    const legacyInner = askUserQuestionLegacyInner(entry.text);
    if (legacyInner !== undefined) {
      const el = doc.createElement('askuserquestion');
      if (entry.lo !== undefined && entry.lo === entry.hi) {
        el.setAttribute('index', String(entry.lo));
      }
      const sections = askUserQuestionSections(entry.text);
      if (sections) {
        const questions = doc.createElement('questions');
        appendCdataText(doc, questions, sections.questions);
        el.appendChild(questions);
        if (sections.answers !== undefined) {
          const answers = doc.createElement('answers');
          appendCdataText(doc, answers, sections.answers);
          el.appendChild(answers);
        }
      } else {
        appendCdataText(doc, el, legacyInner);
      }
      return el;
    }
    const el = doc.createElement('ask-user-question');
    if (entry.lo !== undefined && entry.lo === entry.hi) {
      el.setAttribute('index', String(entry.lo));
    }
    appendCdataText(doc, el, entry.text);
    return el;
  }
  if (entry.kind === 'assistant' && entry.toolName === SKILL_TOOL_NAME) {
    // skill 条目：<skill_content name="…" index="N">，内文为加载内容；
    // 原生 skill_content 包裹形态拆为 <skill_resources> / <skill_instructions> 两段，
    // 各自以 CDATA 包裹，避免层层嵌套包裹。
    const el = doc.createElement('skill_content');
    el.setAttribute('name', entry.skillName ?? '');
    if (entry.lo !== undefined && entry.lo === entry.hi) {
      el.setAttribute('index', String(entry.lo));
    }
    const sections = skillContentSections(entry.text);
    if (sections) {
      const resources = doc.createElement('skill_resources');
      appendCdataText(doc, resources, sections.resources);
      el.appendChild(resources);
      const instructions = doc.createElement('skill_instructions');
      appendCdataText(doc, instructions, sections.instructions);
      el.appendChild(instructions);
    } else {
      appendCdataText(doc, el, entry.text);
    }
    return el;
  }
  const el = doc.createElement('assistant');
  if (entry.lo !== undefined && entry.hi !== undefined && entry.lo === entry.hi) {
    el.setAttribute('index', String(entry.lo));
  } else if (entry.lo !== undefined && entry.hi !== undefined) {
    el.setAttribute('start', String(entry.lo));
    el.setAttribute('end', String(entry.hi));
  }
  appendCdataText(doc, el, entry.text);
  return el;
}

/**
 * 渲染条目序列为 XML 文本（无 <history> 包裹，条目逐行拼接）——getHistory 的输出形式。
 */
export function renderEntriesXml(entries: ViewEntry[]): string {
  if (entries.length === 0) return '';
  const doc = newQuietParser().parseFromString('<root />', 'text/xml');
  const serializer = new XMLSerializer();
  return entries
    .map((entry) => serializer.serializeToString(entryToElement(doc, entry)))
    .join('\n');
}
