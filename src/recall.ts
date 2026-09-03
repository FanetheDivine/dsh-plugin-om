/**
 * recall 工具：按完整消息 index 区间回看原始会话（含被压缩内容）。
 * 导出 recallArgsSchema / RecallArgs / parseRecallArgs / buildRecallTool。
 * 输出值为 { text, images }（契约见 recall-output.ts）；recall 自身不设输出上限，
 * 超大工具结果由 tool-result-pruner 裁剪。
 */

import { z } from 'zod';
import { COMPLETE_MESSAGE_DEFINITION } from './constants.ts';
import { parametersFromZod } from './json-schema.ts';
import { indexCompleteMessages, type PrunerLike, renderCompleteMessageParts } from './log-index.ts';
import {
  type ImageRefValue,
  imageNote,
  RECALL_OUTPUT_SCHEMA,
  type RecallOutputValue,
  renderRecallOutput,
  textOnly,
} from './recall-output.ts';
import type { ToolDefinition, ToolRunContext } from './types.ts';
import { isMainSession } from './utils.ts';

/**
 * recall 工具参数 schema：start 必填；end 与 offset 至少提供一个（同时给出时 end 优先）。
 * 各字段描述经 .describe() 透传到 wire JSON Schema。
 */
export const recallArgsSchema = z
  .object({
    start: z
      .number()
      .describe(
        '完整消息序号（index），作为基准边界，和 end 或 offset 配合，指定区间；end 与 offset 至少提供一个（同时给出时 end 优先）。',
      ),
    end: z.number().optional().describe('与 offset 互斥，指定区间的另一个边界。'),
    offset: z.number().optional().describe('与 end 互斥。相对 start 的步数：正数向后、负数向前。'),
  })
  .refine((args) => args.end !== undefined || args.offset !== undefined, {
    message: 'end 与 offset 至少提供一个',
  });

/** recall 工具调用参数（由 recallArgsSchema 推断）。 */
export type RecallArgs = z.infer<typeof recallArgsSchema>;

/** 解析并校验 recall 调用参数：失败时抛出首个校验问题的可读消息（普通 Error，兼容 SDK 展示）。 */
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

/**
 * 构建 recall 工具定义：按 start/end/offset 定位完整消息区间并渲染原始内容（标 index）。
 * getPruner 返回 tool-result-pruner（可选），用于裁剪超大工具结果。
 */
export function buildRecallTool(getPruner?: () => unknown): ToolDefinition {
  return {
    name: 'recall',
    description: `${COMPLETE_MESSAGE_DEFINITION}此工具可以精确查询完整消息。用index指定一个区间，返回区间内所有完整消息的内容；完整消息携带的图片附件随结果保留（文本段以 [图片附件：…] 标注，随后附 image 内容块）。`,
    parameters: parametersFromZod(recallArgsSchema),
    output: {
      schema: RECALL_OUTPUT_SCHEMA,
      render: (_args, value) => renderRecallOutput(value as RecallOutputValue),
    },
    async execute(args: unknown, exec: ToolRunContext): Promise<RecallOutputValue> {
      const { start, end, offset } = parseRecallArgs(args);
      const session = exec.agent?.session;
      if (!session) return textOnly('会话异常');
      if (!isMainSession(session)) {
        return textOnly('recall 仅主会话可用');
      }
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
        let text = '';
        let cmImages: ImageRefValue[] = [];
        try {
          const rendered = renderCompleteMessageParts(session, cm, pruner);
          text = rendered.text;
          cmImages = rendered.images;
        } catch {
          /* 单条完整消息渲染失败不影响整体 */
        }
        const callAttr = cm.type === 'toolcall' && cm.callId ? ` callId=${cm.callId}` : '';
        let body = text;
        if (cmImages.length > 0) {
          body += (body === '' ? '' : '\n') + cmImages.map(imageNote).join('\n');
          images.push(...cmImages);
        }
        parts.push(`-- [index ${cm.index}] ${cm.type}${callAttr} --\n${body}`);
      }
      if (parts.length === 0) return textOnly('指定区间没有完整消息');
      return { text: parts.join('\n\n'), images };
    },
  };
}
