/**
 * recall 工具：按 message_id 回看原始会话（start_id/end_id 为消息 id，offset 为相对
 * start_id 的消息步数）。recall 自身不设输出上限：超大的工具结果由 tool-result-pruner
 * 裁剪（pruneContent），输出 token 由 pruner 配置控制。
 *
 * 参数由 zod schema（recallArgsSchema）在 execute 入口校验：start_id 必填且非空，
 * end_id/offset 至少提供一个；非法参数抛出可读错误。
 */

import { z } from 'zod';
import { indexMessages } from './log-index.ts';
import type { Message, ToolDefinition, ToolRunContext } from './types.ts';
import { isMainSession, renderMessageText } from './utils.ts';

/**
 * recall 工具参数 schema：start_id 必填且非空；end_id 与 offset 至少提供一个
 * （二者同时给出时 end_id 优先，与 execute 语义一致）；未知键自动剥离。
 */
export const recallArgsSchema = z
  .object({
    start_id: z.string(),
    end_id: z.string().optional(),
    offset: z.number().optional(),
  })
  .refine((args) => args.end_id !== undefined || args.offset !== undefined, {
    message: 'end_id 与 offset 至少提供一个',
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
    // 每个问题带上字段路径（如 start_id / offset），便于模型与日志定位
    throw new Error(
      result.error.issues
        .map((issue) => `${issue.path.join('.') || 'args'}: ${issue.message}`)
        .join('; '),
    );
  }
  return result.data;
}

/**
 * 构建 recall 工具定义：按 start_id/end_id/offset 定位消息区间并渲染原始内容。
 * getPruner 返回 tool-result-pruner（可选），用于裁剪超大工具结果。
 */
export function buildRecallTool(getPruner?: () => unknown): ToolDefinition {
  return {
    name: 'recall',
    description:
      '根据message_id，回看指定区间的过往消息。start_id必须传入，是区间的基准。end_id 和 offset 二选一，end_id 用于指定另一个边界，offset用于指定区间包含的消息数量。',
    parameters: {
      start_id: {
        type: 'string',
        description: 'message_id(uuid)，区间的基准边界',
        required: true,
      },
      end_id: {
        type: 'string',
        description:
          'message_id(uuid)，与 offset 互斥，指定区间的另一个边界。与 start_id 的位置关系不影响结果。',
      },
      offset: {
        type: 'number',
        description:
          '与 end_id 互斥，指定区间包含的消息数量。传入正数查看start_id之后的若干条消息，负数则是之前的。',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: unknown, exec: ToolRunContext) {
      /** 解析并校验后的调用参数（不满足 schema 时抛出可读错误）。 */
      const { start_id, end_id, offset } = parseRecallArgs(args);
      /** 当前会话（缺失则无法回看）。 */
      const session = exec.agent?.session;
      if (!session) return '会话异常';
      if (!isMainSession(session)) {
        return 'recall 仅主会话可用';
      }
      /** 会话消息索引（序列 + byId 映射）。 */
      const { messages, byId } = indexMessages(session);
      /** start_id 在消息序列中的下标。 */
      const startIndex = byId.get(start_id);
      if (startIndex === undefined) {
        return `start_id "${start_id}" 不存在`;
      }
      /** 终点下标（end_id 优先，否则 startIndex + offset）。 */
      let endIndex: number;
      if (end_id !== undefined) {
        // end_id 优先：显式指定终点，忽略 offset
        /** end_id 在消息序列中的下标。 */
        const found = byId.get(end_id);
        if (found === undefined) {
          return `end_id "${end_id}" 不存在`;
        }
        endIndex = found;
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
      const hi = Math.min(messages.length - 1, Math.max(startIndex, endIndex));
      /** tool-result-pruner（可选，裁剪超大工具结果）。 */
      const pruner = getPruner?.() as
        | { pruneContent?: (blocks: readonly unknown[]) => unknown[] | null }
        | undefined;
      /** 渲染结果缓冲（每条消息一段）。 */
      const parts: string[] = [];
      for (let i = lo; i <= hi; i += 1) {
        /** 当前消息节点。 */
        const node = messages[i];
        if (!node) continue;
        /** 节点对应的会话事件。 */
        const event = session.events[node.seq];
        if (!event) continue;
        /** 本条消息的呈现文本。 */
        let text = '';
        try {
          /** 从事件派生的消息对象。 */
          let message: Message | null = session.deriveEventMessage(event);
          if (message && event.type === 'tool/result' && pruner?.pruneContent) {
            /** 裁剪后的内容块（返回 null 表示不裁剪）。 */
            const pruned = pruner.pruneContent(message.content);
            if (pruned) message = { ...message, content: pruned } as Message;
          }
          text = message ? renderMessageText(message) : '';
        } catch {
          /* 单条消息渲染失败不影响整体 */
        }
        parts.push(`-- [seq ${node.seq}] ${event.type} --\n${text}`);
      }
      if (parts.length === 0) return '指定区间没有消息';
      return parts.join('\n\n');
    },
  };
}
