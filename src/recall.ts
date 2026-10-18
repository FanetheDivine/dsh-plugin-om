/**
 * recall 工具：回看原始会话（含被压缩内容）。
 * 导出 recallArgsSchema / RecallArgs / parseRecallArgs / buildRecallTool。
 * - 区间模式：按完整消息 index 的 start/end/offset 精确返回区间内全部完整消息。
 * - 检索模式（带 query）：语义增强启用时按含义检索，否则按字符串匹配，见 semantic-recall.ts。
 * 输出值为 { text, images }（契约见 recall-output.ts），text 为 XML 条目序列
 * （形态见 recall-xml.ts）；recall 自身不设输出上限，超大工具结果由 tool-result-pruner 裁剪。
 */

import { z } from 'zod';
import { COMPLETE_MESSAGE_DEFINITION } from './constants.ts';
import { parametersFromZod } from './json-schema.ts';
import { indexCompleteMessages, type PrunerLike } from './log-index.ts';
import {
  type ImageRefValue,
  RECALL_OUTPUT_SCHEMA,
  type RecallOutputValue,
  renderRecallOutput,
  textOnly,
} from './recall-output.ts';
import { renderCompleteMessageXml } from './recall-xml.ts';
import { keywordSearch, type SemanticOptions, semanticSearch } from './semantic-recall.ts';
import type { ToolDefinition, ToolRunContext } from './types.ts';
import { isMainSession } from './utils.ts';

/**
 * recall 参数 schema：带 query 走检索模式（区间可选，用于限定检索范围）；
 * 不带 query 时 start 必填，end 与 offset 至少提供一个（同时给出时 end 优先）。
 * 各字段描述经 .describe() 透传到 wire JSON Schema。
 */
export const recallArgsSchema = z
  .object({
    query: z
      .string()
      .optional()
      .describe(
        '检索 query（中英文与代码术语皆可）；提供时 start/end/offset 仅用于限定搜索区间，缺省检索全部。',
      ),
    top_k: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe('仅 query 模式：返回最匹配条数（1-10，默认 3）。'),
    start: z
      .number()
      .optional()
      .describe(
        '完整消息 index，基准边界，与 end 或 offset 配合指定区间；未提供 query 时必填，且 end 与 offset 至少提供一个（同时给出时 end 优先）。',
      ),
    end: z.number().optional().describe('与 offset 互斥，指定区间另一边界。'),
    offset: z.number().optional().describe('与 end 互斥，相对 start 的步数（正向后、负向前）。'),
  })
  .superRefine((args, ctx) => {
    if (args.query !== undefined) {
      if (args.query.trim().length === 0) {
        ctx.addIssue({ code: 'custom', path: ['query'], message: 'query 不能为空' });
      }
      return;
    }
    if (args.start === undefined) {
      ctx.addIssue({ code: 'custom', path: ['start'], message: '未提供 query 时 start 必填' });
    } else if (args.end === undefined && args.offset === undefined) {
      ctx.addIssue({ code: 'custom', path: ['end'], message: 'end 与 offset 至少提供一个' });
    }
  });

/** recall 工具调用参数。 */
export type RecallArgs = z.infer<typeof recallArgsSchema>;

/** 解析并校验 recall 调用参数：失败时抛出首个校验问题的可读消息。 */
export function parseRecallArgs(raw: unknown): RecallArgs {
  const result = recallArgsSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      result.error.issues
        .map((issue) => `${issue.path.join('.') || 'args'}: ${issue.message}`)
        .join('; '),
    );
  }
  return result.data;
}

/** 工具描述：两种用法；query 的匹配方式随语义增强开关变化。 */
function recallDescription(semantic: boolean): string {
  const query = semantic
    ? '按自然语言含义检索最符合的完整消息'
    : '按字符串匹配检索完整消息（query 按空白拆词、不区分大小写，按命中词数排序，宜用原文中出现的文件名、函数名、错误码或 key-word 关键词）';
  return `在你需要查看历史消息时调用。${COMPLETE_MESSAGE_DEFINITION}两种用法：1) 给出 start 与 end 或 offset，按 index 区间精确返回区间内全部完整消息的内容；2) 给出 query，${query}，默认全量搜索，可用 start/end/offset 限定区间。注意：query 只匹配文本。`;
}

/** recall 构建选项。 */
export type RecallToolOptions = {
  /** 返回 tool-result-pruner（可选），用于裁剪超大工具结果。 */
  getPruner?: () => unknown;
  /** 提供时 query 走语义检索（内容为可注入的嵌入依赖，测试传替身），否则走字符串匹配。 */
  semantic?: SemanticOptions;
};

/**
 * 构建 recall 工具定义：按 start/end/offset 定位完整消息区间并渲染原始内容（标 index），
 * 或按 query 检索（传入 semantic 选项时语义检索，否则字符串匹配）。
 */
export function buildRecallTool(options?: RecallToolOptions): ToolDefinition {
  const getPruner = options?.getPruner;
  const semantic = options?.semantic;
  return {
    name: 'recall',
    description: recallDescription(semantic !== undefined),
    parameters: parametersFromZod(recallArgsSchema),
    output: {
      schema: RECALL_OUTPUT_SCHEMA,
      render: (_args, value) => renderRecallOutput(value as RecallOutputValue),
    },
    async execute(args: unknown, exec: ToolRunContext): Promise<RecallOutputValue> {
      const { query, top_k, start, end, offset } = parseRecallArgs(args);
      const session = exec.agent?.session;
      if (!session) return textOnly('会话异常');
      if (!isMainSession(session)) {
        return textOnly('recall 仅主会话可用');
      }
      if (query !== undefined) {
        const input = {
          session,
          query,
          topK: top_k,
          start,
          end,
          offset,
          selfCallId: String(exec.callId ?? ''),
          getPruner: () => getPruner?.(),
          options: semantic,
        };
        return semantic ? semanticSearch(input) : keywordSearch(input);
      }
      if (start === undefined) return textOnly('start 必填');
      const cms = indexCompleteMessages(session);
      const startIndex = Number.isFinite(start) ? Math.floor(start) : 0;
      if (startIndex < 0 || startIndex >= cms.length) {
        return textOnly(
          `start ${start} 越界（完整消息共 ${cms.length} 条，index 范围 0..${cms.length - 1}）`,
        );
      }
      let endIndex: number;
      if (end !== undefined) {
        // end 优先：显式指定终点，忽略 offset
        const e = Number.isFinite(end) ? Math.floor(end) : 0;
        if (e < 0 || e >= cms.length) {
          return textOnly(
            `end ${end} 越界（完整消息共 ${cms.length} 条，index 范围 0..${cms.length - 1}）`,
          );
        }
        endIndex = e;
      } else {
        // 仅 offset 生效：正负均可，非整数自动 floor
        const raw = offset ?? 0;
        const step = Number.isFinite(raw) ? Math.floor(raw) : 0;
        endIndex = startIndex + step;
      }
      const lo = Math.max(0, Math.min(startIndex, endIndex));
      const hi = Math.min(cms.length - 1, Math.max(startIndex, endIndex));
      const pruner = getPruner?.() as PrunerLike | undefined;
      const parts: string[] = [];
      const images: ImageRefValue[] = [];
      for (let i = lo; i <= hi; i += 1) {
        const cm = cms[i];
        if (!cm) continue;
        try {
          const rendered = renderCompleteMessageXml(session, cm, { pruner });
          parts.push(rendered.xml);
          images.push(...rendered.images);
        } catch {
          /* 单条完整消息渲染失败不影响整体 */
        }
      }
      if (parts.length === 0) return textOnly('指定区间没有完整消息');
      return { text: parts.join('\n'), images };
    },
  };
}
