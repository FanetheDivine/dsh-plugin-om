/**
 * 压缩工具状态机：历史查看、区间摘要替换、原始 ask 重写与完成门禁。
 * 导出 CompressionState / ToolCallResult / COMPRESSION_TOOL_SCHEMAS /
 * REWRITE_ASK_TOOL_SCHEMA / SKILL_TOOL_NAME。
 * getHistory 与最终 history 共用当前状态投影：本次替换的区间显示为摘要条目。
 * skill 和合法 ask 直接压缩需二次确认；未直接压缩的原始 ask 必须查看后重写。
 * 最终 history 保留用户、系统与历史条目，原始 ask 仅输出重写后的 q/a。
 */

import type { ToolSchema } from '@deepseek-ai/dsh-llm';
import { type CompressionView, renderEntriesXml, type ViewEntry } from './compress-view.ts';
import {
  ASK_USER_QUESTION_TOOL_NAME,
  HISTORY_TAG,
  HISTORY_TIP,
  historyFormatNote,
  SKILL_TOOL_NAME,
} from './constants.ts';

export { SKILL_TOOL_NAME };

/** 工具执行结果（isError=true 时模型应修正调用或改变策略）。 */
export type ToolCallResult = {
  /** 返回给模型的文本。 */
  text: string;
  /** 是否为错误结果（未执行 / 参数非法）。 */
  isError: boolean;
};

/** 一次成功应用的替换区间记录。 */
type Replacement = {
  /** 区间下界（完整消息 index）。 */
  lo: number;
  /** 区间上界（完整消息 index）。 */
  hi: number;
  /** 替换后的摘要文本（纯文本）。 */
  content: string;
};

/** 当前状态投影中的一条：条目、所属压缩块，摘要条目另带其替换记录。 */
type ProjectedEntry = {
  /** 视图条目；摘要条目为 content 构成的 assistant 条目。 */
  entry: ViewEntry;
  /** 所属压缩块 seq；摘要条目取全部被替换条目的块，块外条目为空。 */
  blocks: number[];
  /** 摘要条目对应的替换记录。 */
  replacement?: Replacement;
};

/** 工具参数来自 JSON；验证前仅包含 JSON 值。 */
type ToolJson = string | number | boolean | null | ToolJson[] | { [key: string]: ToolJson };

/** 重写一题的完整内容。 */
type RewrittenQuestion = { ordinal: number; q: string; a: string };

/** 判定 JSON 对象，不接受数组或 null。 */
function isJsonRecord(value: ToolJson): value is { [key: string]: ToolJson } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 合法原始 ask 或已处理的历史 ask；普通失败 toolcall 不包含在内。 */
function isAskEntry(entry: ViewEntry): boolean {
  return (
    entry.kind === 'assistant' &&
    (entry.ask !== undefined ||
      (entry.toolName === ASK_USER_QUESTION_TOOL_NAME && entry.toolArgs === undefined))
  );
}

/** 压缩会话的工具状态：视图 + 替换记录 + 二次确认标记（skill / ask_user_question）+ 完成标记。 */
export class CompressionState {
  private readonly replacements: Replacement[] = [];
  private readonly challengedSkills = new Set<number>();
  private readonly viewedAsks = new Set<number>();
  private readonly undeliveredAsks = new Set<number>();
  private readonly rewrittenAsks = new Map<number, RewrittenQuestion[]>();
  private _completed = false;
  private readonly view: CompressionView;

  /**
   * @param view 压缩视图（观察或反思），工具校验与最终块构建的数据源。
   */
  constructor(view: CompressionView) {
    this.view = view;
  }

  /** 已成功应用的普通摘要替换区间数，不包含 ask 重写。 */
  get replacementCount(): number {
    return this.replacements.length;
  }

  /** 本次视图是否存在原始合法 ask，整个循环内保持稳定。 */
  get hasPendingAsks(): boolean {
    return this.view.entries.some((entry) => entry.ask !== undefined);
  }

  /** 已成功重写且最终未被直接压缩覆盖的 ask 数量。 */
  get rewriteCount(): number {
    return this.view.entries.filter(
      (entry) =>
        entry.ask !== undefined &&
        entry.lo !== undefined &&
        this.rewrittenAsks.has(entry.lo) &&
        !this.coveredBy(entry),
    ).length;
  }

  /** 是否已成功调用 completeCompression。 */
  get completed(): boolean {
    return this._completed;
  }

  /**
   * 执行一次压缩工具调用：解析 JSON 参数并按工具名分发。
   * 未知工具名或参数非法 JSON 返回错误结果，不抛出。
   */
  executeCall(name: string, rawArgs: string): ToolCallResult {
    if (
      name === 'getHistory' ||
      name === 'compressHistory' ||
      name === 'completeCompression' ||
      name === 'rewriteAskUserQuestion'
    ) {
      let args: ToolJson;
      if (typeof rawArgs === 'string' && rawArgs.trim() === '') {
        args = {};
      } else {
        try {
          args = JSON.parse(rawArgs) as ToolJson;
        } catch {
          return { text: `参数不是合法的 JSON：${rawArgs.slice(0, 200)}`, isError: true };
        }
      }
      if (name === 'rewriteAskUserQuestion' && this.hasPendingAsks)
        return this.rewriteAskUserQuestion(args);
      if (name === 'rewriteAskUserQuestion')
        return { text: '本次视图没有待处理的原始 ask', isError: true };
      const record = (args ?? {}) as Record<string, ToolJson>;
      if (name === 'getHistory') return this.getHistory(record);
      if (name === 'compressHistory') return this.compressHistory(record);
      return this.complete();
    }
    return {
      text: `未知工具 ${name}（可用：getHistory / compressHistory${this.hasPendingAsks ? ' / rewriteAskUserQuestion' : ''} / completeCompression）`,
      isError: true,
    };
  }

  /** 下一模型请求已携带成功的 getHistory 结果，允许使用其选项重写。 */
  markHistoryDelivered(): void {
    for (const index of this.undeliveredAsks) this.viewedAsks.add(index);
    this.undeliveredAsks.clear();
  }

  /** 解析可选数值参数（缺省 undefined；非有限数返回 NaN）。 */
  private optionalNumber(value: unknown): number | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) return Number.NaN;
    return Math.floor(value);
  }

  /**
   * getHistory：返回 [start..end] 区间内的当前条目（无 <history> 包裹）。
   * start/end 缺省为要求区间首尾；越界或 start > end 返回错误。本次替换的区间显示为
   * 摘要条目，与查询区间相交即整条返回；区间切入已有压缩块（反思视图）时返回该块当前
   * 全部条目，跨块摘要连带展开其覆盖的块。
   */
  getHistory(args: Record<string, unknown>): ToolCallResult {
    const { minIndex, maxIndex } = this.view;
    if (minIndex === undefined || maxIndex === undefined) {
      return { text: '当前压缩区间没有可定位的条目', isError: true };
    }
    const startRaw = this.optionalNumber(args.start);
    const endRaw = this.optionalNumber(args.end);
    if (startRaw !== undefined && Number.isNaN(startRaw)) {
      return { text: 'start 必须是数字', isError: true };
    }
    if (endRaw !== undefined && Number.isNaN(endRaw)) {
      return { text: 'end 必须是数字', isError: true };
    }
    const start = startRaw ?? minIndex;
    const end = endRaw ?? maxIndex;
    if (start < minIndex || start > maxIndex) {
      return {
        text: `start ${start} 越界（要求区间 [${minIndex}..${maxIndex}]）`,
        isError: true,
      };
    }
    if (end < minIndex || end > maxIndex) {
      return { text: `end ${end} 越界（要求区间 [${minIndex}..${maxIndex}]）`, isError: true };
    }
    if (start > end) {
      return { text: `start ${start} 不能大于 end ${end}`, isError: true };
    }
    const intersects = (entry: ViewEntry): boolean =>
      entry.lo !== undefined && entry.hi !== undefined && entry.lo <= end && entry.hi >= start;
    const projected = this.project();
    // 块整体展开：相交条目所属的块全部展开；摘要可跨块，展开到不再新增块为止
    const expanded = new Set<number>();
    for (let grown = true; grown; ) {
      grown = false;
      for (const item of projected) {
        if (!intersects(item.entry) && !item.blocks.some((seq) => expanded.has(seq))) continue;
        for (const seq of item.blocks) {
          if (expanded.has(seq)) continue;
          expanded.add(seq);
          grown = true;
        }
      }
    }
    const selected = projected.filter((item) =>
      item.blocks.length > 0
        ? item.blocks.some((seq) => expanded.has(seq))
        : intersects(item.entry),
    );
    if (selected.length === 0) {
      return { text: `区间 [${start}..${end}] 没有条目`, isError: false };
    }
    const text = renderEntriesXml(selected.map((item) => item.entry));
    for (const { entry } of selected) {
      if (entry.ask !== undefined && entry.lo !== undefined) this.undeliveredAsks.add(entry.lo);
    }
    return { text, isError: false };
  }

  /** 区间的简短描述（单条 index / 区间 start..end）。 */
  private static spanLabel(lo: number, hi: number): string {
    return lo === hi ? `完整消息 index ${lo}` : `完整消息区间 [${lo}..${hi}]`;
  }

  /**
   * compressHistory：把 index 单条或 start..end 连续区间的 assistant 条目替换为
   * content 摘要。校验失败返回错误结果（不应用）；skill / ask_user_question 条目
   * 首次被覆盖返回要求重新思考的错误结果（不应用，标记已挑战）；通过后记录替换并
   * 覆盖被完全包含的旧替换。
   */
  compressHistory(args: Record<string, unknown>): ToolCallResult {
    const { minIndex, maxIndex } = this.view;
    if (minIndex === undefined || maxIndex === undefined) {
      return { text: '当前压缩区间没有可定位的条目', isError: true };
    }
    const content = args.content;
    if (typeof content !== 'string' || content.trim() === '') {
      return { text: 'content 必须是非空摘要文本', isError: true };
    }
    if (content.includes('<![CDATA[')) {
      return {
        text: 'content 必须是纯文本摘要，不要包含 CDATA 包裹（<![CDATA[…]]>）；CDATA 由插件在构建块时自动添加，请去除后重新提交',
        isError: true,
      };
    }
    const hasIndex = args.index !== undefined && args.index !== null;
    const hasStart = args.start !== undefined && args.start !== null;
    const hasEnd = args.end !== undefined && args.end !== null;
    if (hasIndex && (hasStart || hasEnd)) {
      return { text: 'index 与 start/end 不能同时提供', isError: true };
    }
    if (hasStart !== hasEnd) {
      return { text: 'start 与 end 必须成对提供', isError: true };
    }
    let lo: number;
    let hi: number;
    if (hasIndex) {
      const index = args.index;
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
        return { text: 'index 必须是非负整数', isError: true };
      }
      lo = index;
      hi = index;
    } else if (hasStart) {
      const start = args.start;
      const end = args.end;
      if (
        typeof start !== 'number' ||
        typeof end !== 'number' ||
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 0 ||
        end < 0
      ) {
        return { text: 'start 与 end 必须是非负整数', isError: true };
      }
      if (start > end) {
        return { text: `start ${start} 不能大于 end ${end}`, isError: true };
      }
      lo = start;
      hi = end;
    } else {
      return { text: 'index 与 start/end 至少提供一个', isError: true };
    }
    if (lo < minIndex || hi > maxIndex) {
      return {
        text: `${CompressionState.spanLabel(lo, hi)} 超出要求的压缩区间 [${minIndex}..${maxIndex}]`,
        isError: true,
      };
    }
    // 条目校验：相交条目不可为 user；assistant 条目必须被完整包含；区间内须有可压缩条目
    let insideCount = 0;
    for (const entry of this.view.entries) {
      if (entry.lo === undefined || entry.hi === undefined) continue;
      if (entry.lo > hi || entry.hi < lo) continue;
      if (entry.kind === 'user') {
        return {
          text: `${CompressionState.spanLabel(lo, hi)} 覆盖用户消息（index ${entry.lo}），用户消息不可压缩`,
          isError: true,
        };
      }
      if (entry.kind === 'assistant' && !(entry.lo >= lo && entry.hi <= hi)) {
        return {
          text: `${CompressionState.spanLabel(lo, hi)} 与 assistant 条目 [${entry.lo}..${entry.hi}] 部分重叠，需完整包含或不相交`,
          isError: true,
        };
      }
      if (entry.kind === 'assistant') insideCount += 1;
    }
    if (insideCount === 0) {
      return {
        text: `${CompressionState.spanLabel(lo, hi)} 内没有可压缩的 assistant 条目`,
        isError: true,
      };
    }
    // 已有替换区间：相交时必须被新区间完全包含（完全覆盖），部分重叠报错
    for (const rep of this.replacements) {
      if (rep.lo <= hi && rep.hi >= lo && !(rep.lo >= lo && rep.hi <= hi)) {
        return {
          text: `${CompressionState.spanLabel(lo, hi)} 与已有替换区间 [${rep.lo}..${rep.hi}] 部分重叠，只能完全包含或不相交。[${rep.lo}..${rep.hi}] 已生效，修改其摘要时用相同或更大的区间重新提交`,
          isError: true,
        };
      }
    }
    // 二次确认：区间覆盖 skill 加载或 ask_user_question 条目时，首次被覆盖不执行
    const unchallenged: number[] = [];
    let challengedTool: string | undefined;
    for (const entry of this.view.entries) {
      if (entry.kind !== 'assistant') continue;
      if (entry.toolName !== SKILL_TOOL_NAME && !isAskEntry(entry)) continue;
      if (entry.lo === undefined || entry.lo < lo || entry.lo > hi) continue;
      if (!this.challengedSkills.has(entry.lo)) {
        unchallenged.push(entry.lo);
        challengedTool = entry.toolName;
      }
    }
    if (unchallenged.length > 0) {
      for (const index of unchallenged) this.challengedSkills.add(index);
      if (challengedTool === ASK_USER_QUESTION_TOOL_NAME) {
        const rawAsk = this.view.entries.some(
          (entry) =>
            entry.ask !== undefined && entry.lo !== undefined && unchallenged.includes(entry.lo),
        );
        return {
          text: `${CompressionState.spanLabel(lo, hi)} 包含 ask_user_question 向用户的提问（完整消息 index ${unchallenged.join('、')}）。请重新思考该提问是否确定与后续任务无关：确定不相关时再次调用 compressHistory 压缩该区间；不确定或相关时不要压缩该区间，${rawAsk ? '请先查看，再调用 rewriteAskUserQuestion 重写后保留' : '保持原样即可'}`,
          isError: true,
        };
      }
      return {
        text: `${CompressionState.spanLabel(lo, hi)} 包含 skill 加载（完整消息 index ${unchallenged.join('、')}）。请重新思考该 skill 是否确定与后续任务无关：确定不相关时再次调用 compressHistory 压缩该区间；不确定或相关时不要压缩该区间，保持原样即可`,
        isError: true,
      };
    }
    // 应用：移除被完全包含的旧替换，记录新替换
    for (let i = this.replacements.length - 1; i >= 0; i -= 1) {
      const rep = this.replacements[i];
      if (rep === undefined) continue;
      if (rep.lo >= lo && rep.hi <= hi) this.replacements.splice(i, 1);
    }
    this.replacements.push({ lo, hi, content });
    return {
      text: `已压缩${CompressionState.spanLabel(lo, hi)}（${insideCount} 条 assistant 条目）`,
      isError: false,
    };
  }

  /** 完全包含该条目的替换记录；替换区间两两不相交，至多一条。 */
  private replacementFor(entry: ViewEntry): Replacement | undefined {
    const { lo, hi } = entry;
    if (lo === undefined || hi === undefined) return undefined;
    return this.replacements.find((rep) => lo >= rep.lo && hi <= rep.hi);
  }

  /** 条目是否已被成功直接压缩完全覆盖。 */
  private coveredBy(entry: ViewEntry): boolean {
    return this.replacementFor(entry) !== undefined;
  }

  /**
   * 当前状态投影：按视图顺序，被替换条目由一条摘要条目代替，摘要位于首个被替换条目处。
   * reasoning 带 index 时按自身区间取舍，无 index 时跟随其后第一条非 reasoning 条目。
   */
  private project(): ProjectedEntry[] {
    const entries = this.view.entries;
    const reps = new Array<Replacement | undefined>(entries.length);
    let next: Replacement | undefined;
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      if (entry === undefined) continue;
      const own = this.replacementFor(entry);
      if (entry.kind !== 'reasoning') next = own;
      reps[i] = entry.kind === 'reasoning' && entry.lo === undefined ? next : own;
    }
    const projected: ProjectedEntry[] = [];
    const summaries = new Map<Replacement, ProjectedEntry>();
    entries.forEach((entry, i) => {
      const rep = reps[i];
      if (rep === undefined) {
        projected.push({ entry, blocks: entry.blockSeq === undefined ? [] : [entry.blockSeq] });
        return;
      }
      let summary = summaries.get(rep);
      if (summary === undefined) {
        summary = {
          entry: { kind: 'assistant', lo: rep.lo, hi: rep.hi, text: rep.content },
          blocks: [],
          replacement: rep,
        };
        summaries.set(rep, summary);
        projected.push(summary);
      }
      if (entry.blockSeq !== undefined && !summary.blocks.includes(entry.blockSeq)) {
        summary.blocks.push(entry.blockSeq);
      }
    });
    return projected;
  }

  /** 重写已查看、尚未压缩覆盖的原始 ask，一次提交全部题。 */
  private rewriteAskUserQuestion(args: ToolJson): ToolCallResult {
    if (!isJsonRecord(args) || Object.keys(args).some((key) => key !== 'index' && key !== 'qa')) {
      return { text: '重写参数必须是仅含 index 与 qa 的对象', isError: true };
    }
    const { index, qa } = args;
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) {
      return { text: 'index 必须是非负整数', isError: true };
    }
    const entry = this.view.entries.find(
      (item) =>
        item.kind === 'assistant' &&
        item.lo === index &&
        item.hi === index &&
        item.ask !== undefined,
    );
    if (entry?.ask === undefined) {
      return { text: `index ${index} 不是本次视图中的合法原始 ask`, isError: true };
    }
    if (this.coveredBy(entry)) {
      return { text: `index ${index} 已被 compressHistory 覆盖，不能重写`, isError: true };
    }
    if (!this.viewedAsks.has(index)) {
      return {
        text: `请先用 getHistory 查看 index ${index} 的问题、选项和回答，收到返回结果后的下一轮再重写，不要在同轮提交`,
        isError: true,
      };
    }
    if (!Array.isArray(qa) || qa.length !== entry.ask.questions.length) {
      return {
        text: `qa 必须包含 index ${index} 的全部 ${entry.ask.questions.length} 题`,
        isError: true,
      };
    }
    const rewritten: RewrittenQuestion[] = [];
    const ordinals = new Set<number>();
    for (const item of qa) {
      if (
        !isJsonRecord(item) ||
        Object.keys(item).some((key) => !['ordinal', 'q', 'a'].includes(key))
      ) {
        return { text: '每题只能包含 ordinal、q、a，不要提交 options 或其他字段', isError: true };
      }
      const { ordinal, q, a } = item;
      if (
        typeof ordinal !== 'number' ||
        !Number.isInteger(ordinal) ||
        ordinal < 1 ||
        ordinal > qa.length ||
        ordinals.has(ordinal)
      ) {
        return { text: `ordinal 必须覆盖 1..${qa.length} 的全部题序且不能重复`, isError: true };
      }
      if (typeof q !== 'string' || q.trim() === '' || typeof a !== 'string' || a.trim() === '') {
        return { text: 'q 与 a 必须是非空纯文本；未回答的题明确写 (未回答)', isError: true };
      }
      if (q.includes('<![CDATA[') || a.includes('<![CDATA[')) {
        return { text: 'q 与 a 不要包含 CDATA 包裹，插件会自动添加', isError: true };
      }
      if (/^\s*o\d+\s*[:：]/m.test(q) || /^\s*o\d+\s*[:：]/m.test(a)) {
        return {
          text: 'q 与 a 不要包含 oN: 选项列表行；请将回答中的选项引用展开为自足表述',
          isError: true,
        };
      }
      ordinals.add(ordinal);
      rewritten.push({ ordinal, q, a });
    }
    rewritten.sort((a, b) => a.ordinal - b.ordinal);
    this.rewrittenAsks.set(index, rewritten);
    return { text: `已重写完整消息 index ${index} 的 ${rewritten.length} 题`, isError: false };
  }

  /** 尚未直接压缩或重写的原始 ask index。 */
  private unprocessedAskIndices(): number[] {
    return this.view.entries.flatMap((entry) =>
      entry.ask !== undefined &&
      entry.lo !== undefined &&
      !this.coveredBy(entry) &&
      !this.rewrittenAsks.has(entry.lo)
        ? [entry.lo]
        : [],
    );
  }

  /** completeCompression：所有原始合法 ask 已压缩或重写后标记完成；result 为最终 <history> 块。 */
  complete(): ToolCallResult {
    const pending = this.unprocessedAskIndices();
    if (pending.length > 0) {
      return {
        text: `尚未处理原始 ask（index ${pending.join('、')}）：请直接压缩，或先查看再调用 rewriteAskUserQuestion 重写后保留`,
        isError: true,
      };
    }
    this._completed = true;
    // 返回与压缩日志一致的 <history> 块，会话记录里才能直接看到压缩产物
    return { text: this.buildFinalBlock(), isError: false };
  }

  /**
   * 构建最终 <history> 块：取当前状态投影并去掉 reasoning——user 条目原样、被替换区间为
   * <assistant index|start end> 摘要条目、未替换普通与历史条目原样保留，原始 ask 使用
   * 重写后的 q/a。块首按最终条目动态生成格式说明注释，开标签携带 tip 属性。
   */
  buildFinalBlock(): string {
    const pending = this.unprocessedAskIndices();
    if (pending.length > 0) throw new Error(`原始 ask 尚未处理：index ${pending.join('、')}`);
    const entries = this.project().flatMap(({ entry }): ViewEntry[] => {
      if (entry.kind === 'reasoning') return [];
      const qa = entry.lo === undefined ? undefined : this.rewrittenAsks.get(entry.lo);
      if (entry.ask === undefined || qa === undefined || entry.lo === undefined) return [entry];
      return [
        {
          kind: 'assistant',
          lo: entry.lo,
          hi: entry.lo,
          toolName: ASK_USER_QUESTION_TOOL_NAME,
          text: `<ask-user-question>${qa.map((item) => `q:${item.q}\na:${item.a}`).join('\n')}</ask-user-question>`,
        },
      ];
    });
    // 块顶注释按产物内实际存在的条目动态生成：被替换的 skill / ask_user_question 已变为摘要条目
    const note = historyFormatNote({
      user: entries.some((e) => e.kind === 'user'),
      skill: entries.some((e) => e.kind === 'assistant' && e.toolName === SKILL_TOOL_NAME),
      askUserQuestion: entries.some(isAskEntry),
    });
    return `<${HISTORY_TAG} tip="${HISTORY_TIP}">\n${note}\n${renderEntriesXml(entries)}\n</${HISTORY_TAG}>`;
  }
}

/** 仅含原始合法 ask 的压缩会话使用的重写工具。 */
export const REWRITE_ASK_TOOL_SCHEMA: ToolSchema = {
  name: 'rewriteAskUserQuestion',
  description:
    '重写已用 getHistory 查看且未被 compressHistory 覆盖的原始 ask。按原题序提交全部 q/a，忠实精炼问题与回答，展开选项引用，未回答的题明确写 (未回答)。保留 ask 的产物只含 q/a，不提交 options 或 CDATA 包裹。',
  parameters: {
    type: 'object',
    properties: {
      index: { type: 'integer', minimum: 0, description: '原始合法 ask 的完整消息 index' },
      qa: {
        type: 'array',
        minItems: 1,
        description: '该调用内全部题的重写结果，保留题数和原题序',
        items: {
          type: 'object',
          properties: {
            ordinal: { type: 'integer', minimum: 1, description: '原始题序，从 1 开始' },
            q: { type: 'string', minLength: 1, description: '忠实精炼后的问题纯文本' },
            a: {
              type: 'string',
              minLength: 1,
              description: '自足的回答纯文本，保留用户条件和决定；未回答写 (未回答)',
            },
          },
          required: ['ordinal', 'q', 'a'],
          additionalProperties: false,
        },
      },
    },
    required: ['index', 'qa'],
    additionalProperties: false,
  },
};

/** 压缩会话基础工具的 wire 定义（GenerateOptions.tools）。 */
export const COMPRESSION_TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: 'getHistory',
    description:
      '查看压缩区间内的历史条目，返回当前状态：本次已压缩的区间显示为摘要条目；区间切入已有 <history> 块时返回该块全部条目。start/end 缺省为要求区间的第一个/最后一个完整消息 index，必须在要求区间内。',
    parameters: {
      type: 'object',
      properties: {
        start: { type: 'number', description: '区间起始完整消息 index（缺省为要求区间第一个）' },
        end: { type: 'number', description: '区间结束完整消息 index（缺省为要求区间最后一个）' },
      },
    },
  },
  {
    name: 'compressHistory',
    description:
      '把 index 单条或 start..end 连续区间的 assistant 类条目（模型输出文本、工具调用）替换为 content 摘要。index 与 start/end 二选一，start 与 end 成对提供且 start==end 等同 index。区间不得覆盖用户消息，不得与已有替换区间部分重叠（完全包含则覆盖）。返回成功即已生效，无需查看验证，不要用单条 index 试探；修改已提交的摘要时用相同或更大的区间重新提交。用户消息保持原样，无需处理。',
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'number', description: '单条完整消息 index' },
        start: { type: 'number', description: '区间起始完整消息 index（与 end 成对提供）' },
        end: { type: 'number', description: '区间结束完整消息 index（与 start 成对提供）' },
        content: {
          type: 'string',
          description: '替换后的摘要文本（纯文本，不要包含 CDATA 包裹，插件自动包裹）',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'completeCompression',
    description:
      '处理完成后调用，成功时立即结束压缩会话。原始合法 ask 必须已成功压缩，或先查看并重写后保留；其他未压缩条目原样保留。无待处理的原始 ask 时允许直接完成。',
    parameters: { type: 'object', properties: {} },
  },
];
