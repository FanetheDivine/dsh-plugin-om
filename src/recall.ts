/**
 * recall 工具：按「完整消息」序号（index）回看原始会话（start/end 为完整消息 index，
 * offset 为相对 start 的完整消息步数）。完整消息即 `用户消息`（user_message 中 kind 为 user
 * 的部分）、`系统消息`（user_message 中其余 kind 的部分）、`模型输出文本`和`具有result的
 * toolcall`；首条完整消息的 index 为 0，后续递增、会话内全局稳定，与摘要日志条目同一套编号。
 * recall 自身不设输出上限：超大的工具结果由 tool-result-pruner 裁剪（pruneContent），
 * 输出 token 由 pruner 配置控制。
 *
 * 参数由 zod schema（recallArgsSchema）在 execute 入口校验：start 必填（number），
 * end/offset 至少提供一个；非法参数抛出可读错误。
 */

import { z } from 'zod';
import { COMPLETE_MESSAGE_DEFINITION } from './constants.ts';
import { indexCompleteMessages, type PrunerLike, renderCompleteMessage } from './log-index.ts';
import type { ToolDefinition, ToolRunContext } from './types.ts';
import { isMainSession } from './utils.ts';

/**
 * recall 工具参数 schema：start 必填（number）；end 与 offset 至少提供一个
 * （二者同时给出时 end 优先，与 execute 语义一致）；未知键自动剥离。
 */
export const recallArgsSchema = z
  .object({
    start: z.number(),
    end: z.number().optional(),
    offset: z.number().optional(),
  })
  .refine((args) => args.end !== undefined || args.offset !== undefined, {
    message: 'end 与 offset 至少提供一个',
  });

/** recall 工具调用参数（由 recallArgsSchema 推断）。 */
export type RecallArgs = z.infer<typeof recallArgsSchema>;

/**
 * 解析并校验 recall 调用参数：校验失败时抛出首个校验问题的可读消息
 * （普通 Error 而非 ZodError，兼容 SDK 展示）。
 */
export function parseRecallArgs(raw: unknown): RecallArgs {
  /** safeParse 结果（成功时 data 为 RecallArgs，失败时 error 携带问题列表）。 */
  const result = recallArgsSchema.safeParse(raw);
  if (!result.success) {
    // 每个问题带上字段路径（如 start / offset），便于模型与日志定位
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
    description: `${COMPLETE_MESSAGE_DEFINITION}此工具可以精确查询完整消息。用index指定一个区间，返回区间内所有完整消息的内容。`,
    parameters: {
      start: {
        type: 'number',
        description: '完整消息序号（index），作为基准边界，和end或offset配合，指定区间',
        required: true,
      },
      end: {
        type: 'number',
        description: '与 offset 互斥，指定区间的另一个边界。',
      },
      offset: {
        type: 'number',
        description: '与 end 互斥。相对 start 的步数：正数向后、负数向前。',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: unknown, exec: ToolRunContext) {
      /** 解析并校验后的调用参数（不满足 schema 时抛出可读错误）。 */
      const { start, end, offset } = parseRecallArgs(args);
      /** 当前会话（缺失则无法回看）。 */
      const session = exec.agent?.session;
      if (!session) return '会话异常';
      if (!isMainSession(session)) {
        return 'recall 仅主会话可用';
      }
      /** 完整消息索引（index = 数组下标，0 起）。 */
      const cms = indexCompleteMessages(session);
      /** 起始下标（非整数 floor；越界返回提示）。 */
      const startIndex = Number.isFinite(start) ? Math.floor(start) : 0;
      if (startIndex < 0 || startIndex >= cms.length) {
        return `start ${start} 越界（完整消息共 ${cms.length} 条，index 范围 0..${cms.length - 1}）`;
      }
      /** 终点下标（end 优先，否则 startIndex + offset）。 */
      let endIndex: number;
      if (end !== undefined) {
        // end 优先：显式指定终点，忽略 offset
        /** end 取整（非整数 floor）。 */
        const e = Number.isFinite(end) ? Math.floor(end) : 0;
        if (e < 0 || e >= cms.length) {
          return `end ${end} 越界（完整消息共 ${cms.length} 条，index 范围 0..${cms.length - 1}）`;
        }
        endIndex = e;
      } else {
        // 仅 offset 生效：正负均可，非整数自动 floor（负数向更早方向取整）
        /** offset 数值（refine 保证此分支 offset 已提供，schema 保证为 number）。 */
        const raw = offset ?? 0;
        /** 向下取整后的步数（非有限数按 0 处理）。 */
        const step = Number.isFinite(raw) ? Math.floor(raw) : 0;
        endIndex = startIndex + step;
      }
      /** 区间下界（钳制到 [0, len-1]）。 */
      const lo = Math.max(0, Math.min(startIndex, endIndex));
      /** 区间上界（钳制到 [0, len-1]）。 */
      const hi = Math.min(cms.length - 1, Math.max(startIndex, endIndex));
      /** tool-result-pruner（可选，裁剪超大工具结果）。 */
      const pruner = getPruner?.() as PrunerLike | undefined;
      /** 渲染结果缓冲（每条完整消息一段，标 index + 类型）。 */
      const parts: string[] = [];
      for (let i = lo; i <= hi; i += 1) {
        /** 当前完整消息。 */
        const cm = cms[i];
        if (!cm) continue;
        /** 该条完整消息的呈现文本（pruner 裁剪超大结果；单条失败不影响整体）。 */
        let text = '';
        try {
          text = renderCompleteMessage(session, cm, pruner);
        } catch {
          /* 单条完整消息渲染失败不影响整体 */
        }
        /** 类型标注（toolcall 附调用 id，便于模型关联）。 */
        const callAttr = cm.type === 'toolcall' && cm.callId ? ` callId=${cm.callId}` : '';
        parts.push(`-- [index ${cm.index}] ${cm.type}${callAttr} --\n${text}`);
      }
      if (parts.length === 0) return '指定区间没有完整消息';
      return parts.join('\n\n');
    },
  };
}
