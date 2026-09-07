/**
 * 压缩工具状态机：getHistory / compressHistory / completeCompression 的参数解析、
 * 校验与执行，以及最终 <history> 块构建。导出 CompressionState / ToolCallResult /
 * COMPRESSION_TOOL_SCHEMAS / SKILL_TOOL_NAME。
 *
 * - getHistory：查看要求区间内的条目（压缩视图，无 <history> 包裹；区间切入已有
 *   压缩块时返回整块全部条目；start/end 缺省为要求区间首尾）
 * - compressHistory：把 index 单条或 start..end 连续区间的 assistant 条目替换为
 *   content 摘要（纯文本，构建最终块时转义嵌入）。参数非法 / 越界 / 覆盖用户或
 *   系统消息 / 与条目或已有替换区间部分重叠 → 返回错误结果（模型可修正重试）；
 *   重复覆盖同一区间：新区间完全包含旧区间时覆盖，部分重叠时报错
 * - skill 规则：区间覆盖工具名为 skill 的 toolcall 条目时，该 skill 块首次被覆盖
 *   不执行、返回要求重新思考的提示；之后再次覆盖它的调用直接执行
 * - completeCompression：标记完成（调用后压缩会话立即停止）；空提交（0 次成功
 *   压缩）允许
 * - 最终 <history> 块由插件从视图与替换记录构建：user / sys 条目原样、被替换区间
 *   生成新摘要条目、未替换 assistant 条目原样保留、reasoning 不进产物；产物天然
 *   合法 XML，无需校验
 */

import type { ToolSchema } from '@deepseek-ai/dsh-llm';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import {
  type CompressionView,
  entryToElement,
  renderEntriesXml,
  type ViewEntry,
} from './compress-view.ts';
import { HISTORY_FORMAT_NOTE, HISTORY_TAG, HISTORY_TIP, SKILL_TOOL_NAME } from './constants.ts';

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

/** 压缩会话的工具状态：视图 + 替换记录 + skill 二次确认标记 + 完成标记。 */
export class CompressionState {
  private readonly replacements: Replacement[] = [];
  private readonly challengedSkills = new Set<number>();
  private _completed = false;

  /**
   * @param view 压缩视图（观察或反思），工具校验与最终块构建的数据源。
   */
  constructor(private readonly view: CompressionView) {}

  /** 已成功应用的替换次数（0 表示空提交）。 */
  get replacementCount(): number {
    return this.replacements.length;
  }

  /** 是否已调用 completeCompression。 */
  get completed(): boolean {
    return this._completed;
  }

  /**
   * 执行一次压缩工具调用：解析 JSON 参数并按工具名分发。
   * 未知工具名或参数非法 JSON 返回错误结果，不抛出。
   */
  executeCall(name: string, rawArgs: string): ToolCallResult {
    if (name === 'getHistory' || name === 'compressHistory' || name === 'completeCompression') {
      let args: unknown;
      if (typeof rawArgs === 'string' && rawArgs.trim() === '') {
        args = {};
      } else {
        try {
          args = JSON.parse(rawArgs);
        } catch {
          return { text: `参数不是合法的 JSON：${rawArgs.slice(0, 200)}`, isError: true };
        }
      }
      const record = (args ?? {}) as Record<string, unknown>;
      if (name === 'getHistory') return this.getHistory(record);
      if (name === 'compressHistory') return this.compressHistory(record);
      return this.complete();
    }
    return {
      text: `未知工具 ${name}（可用：getHistory / compressHistory / completeCompression）`,
      isError: true,
    };
  }

  /** 解析可选数值参数（缺省 undefined；非有限数返回 NaN）。 */
  private optionalNumber(value: unknown): number | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) return Number.NaN;
    return Math.floor(value);
  }

  /**
   * getHistory：返回 [start..end] 区间内的条目（压缩视图，无 <history> 包裹）。
   * start/end 缺省为要求区间首尾；越界或 start > end 返回错误。区间切入已有压缩
   * 块（反思视图）时返回该块全部条目。
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
    // 块整体展开：任一条目相交的压缩块，其全部条目一并返回
    const expandedBlocks = new Set<number>();
    for (const entry of this.view.entries) {
      if (entry.blockSeq !== undefined && intersects(entry)) expandedBlocks.add(entry.blockSeq);
    }
    const selected = this.view.entries.filter((entry) =>
      entry.blockSeq !== undefined ? expandedBlocks.has(entry.blockSeq) : intersects(entry),
    );
    if (selected.length === 0) {
      return { text: `区间 [${start}..${end}] 没有条目`, isError: false };
    }
    return {
      text: `<!-- 完整消息区间 [${start}..${end}]，共 ${selected.length} 条 -->\n${renderEntriesXml(selected)}`,
      isError: false,
    };
  }

  /** 区间的简短描述（单条 index / 区间 start..end）。 */
  private static spanLabel(lo: number, hi: number): string {
    return lo === hi ? `完整消息 index ${lo}` : `完整消息区间 [${lo}..${hi}]`;
  }

  /**
   * compressHistory：把 index 单条或 start..end 连续区间的 assistant 条目替换为
   * content 摘要。校验失败返回错误结果（不应用）；skill 块首次被覆盖返回要求
   * 重新思考的错误结果（不应用，标记已挑战）；通过后记录替换并覆盖被完全包含
   * 的旧替换。
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
    // 条目校验：相交条目不可为 user / sys；assistant 条目必须被完整包含；区间内须有可压缩条目
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
      if (entry.kind === 'sys') {
        return {
          text: `${CompressionState.spanLabel(lo, hi)} 覆盖系统消息（index ${entry.lo}），系统消息不可压缩`,
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
          text: `${CompressionState.spanLabel(lo, hi)} 与已有替换区间 [${rep.lo}..${rep.hi}] 部分重叠，只能完全包含或不相交`,
          isError: true,
        };
      }
    }
    // skill 二次确认：区间覆盖工具名为 skill 的条目时，首次被覆盖不执行
    const unchallenged: number[] = [];
    for (const entry of this.view.entries) {
      if (entry.kind !== 'assistant' || entry.toolName !== SKILL_TOOL_NAME) continue;
      if (entry.lo === undefined || entry.lo < lo || entry.lo > hi) continue;
      if (!this.challengedSkills.has(entry.lo)) unchallenged.push(entry.lo);
    }
    if (unchallenged.length > 0) {
      for (const index of unchallenged) this.challengedSkills.add(index);
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

  /** completeCompression：标记压缩完成（调用后压缩会话立即停止）。 */
  complete(): ToolCallResult {
    this._completed = true;
    return { text: '压缩完成', isError: false };
  }

  /**
   * 构建最终 <history> 块：按 index 顺序合并视图条目与替换记录——user / sys 条目
   * 原样、被替换区间生成 <assistant index|start end> 摘要条目（content 转义嵌入）、
   * 未替换 assistant 条目原样保留、reasoning 不进产物；块首为格式说明注释，开标签
   * 携带 tip 属性。产物为合法 XML，无需校验。
   */
  buildFinalBlock(): string {
    const doc = new DOMParser({ onError: () => {} }).parseFromString(
      `<${HISTORY_TAG} />`,
      'text/xml',
    );
    const root = doc.documentElement;
    if (!root) return '';
    const coveredBy = (entry: ViewEntry): boolean =>
      entry.lo !== undefined &&
      entry.hi !== undefined &&
      this.replacements.some(
        (rep) =>
          entry.lo !== undefined &&
          entry.hi !== undefined &&
          entry.lo >= rep.lo &&
          entry.hi <= rep.hi,
      );
    const reps = [...this.replacements].sort((a, b) => a.lo - b.lo);
    let nextRep = 0;
    const emitReplacement = (rep: Replacement): void => {
      const el = doc.createElement('assistant');
      if (rep.lo === rep.hi) el.setAttribute('index', String(rep.lo));
      else {
        el.setAttribute('start', String(rep.lo));
        el.setAttribute('end', String(rep.hi));
      }
      el.appendChild(doc.createTextNode(rep.content));
      root.appendChild(el);
    };
    const flushReplacementsBefore = (lo: number | undefined): void => {
      while (nextRep < reps.length) {
        const rep = reps[nextRep];
        if (rep === undefined) break;
        if (lo !== undefined && rep.lo >= lo) break;
        emitReplacement(rep);
        nextRep += 1;
      }
    };
    for (const entry of this.view.entries) {
      if (entry.kind === 'reasoning') continue;
      if (coveredBy(entry)) continue;
      flushReplacementsBefore(entry.lo);
      root.appendChild(entryToElement(doc, entry));
    }
    flushReplacementsBefore(undefined);
    const serializer = new XMLSerializer();
    const inner = Array.from(root.childNodes)
      .map((node) => serializer.serializeToString(node))
      .join('\n');
    return `<${HISTORY_TAG} tip="${HISTORY_TIP}">\n${HISTORY_FORMAT_NOTE}\n${inner}\n</${HISTORY_TAG}>`;
  }
}

/** 压缩会话工具的 wire 定义（GenerateOptions.tools）。 */
export const COMPRESSION_TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: 'getHistory',
    description:
      '查看压缩区间内的历史条目。返回压缩视图：已被压缩的内容以摘要条目呈现，区间切入已压缩块时返回该块全部条目。start/end 缺省为要求区间的第一个/最后一个完整消息 index，必须在要求区间内。',
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
      '把 index 单条或 start..end 连续区间的 assistant 类条目（模型输出文本、工具调用）替换为 content 摘要。index 与 start/end 二选一，start 与 end 成对提供且 start==end 等同 index。区间不得覆盖用户消息或系统消息，不得与已有替换区间部分重叠（完全包含则覆盖）。用户消息与系统消息保持原样，无需处理。',
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'number', description: '单条完整消息 index' },
        start: { type: 'number', description: '区间起始完整消息 index（与 end 成对提供）' },
        end: { type: 'number', description: '区间结束完整消息 index（与 start 成对提供）' },
        content: { type: 'string', description: '替换后的摘要文本（纯文本）' },
      },
      required: ['content'],
    },
  },
  {
    name: 'completeCompression',
    description:
      '全部压缩完成后调用，立即结束压缩会话。未压缩的条目将原样保留，允许不压缩任何内容直接完成。',
    parameters: { type: 'object', properties: {} },
  },
];
