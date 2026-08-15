/**
 * recall-semantic 工具：按自然语言 query 对会话全部消息日志（含被压缩/遮蔽的
 * user/assistant/tool-result 事件）做语义检索，返回最匹配的完整消息与匹配说明。
 *
 * - 参数：query 必填；top_k（默认 3，1-10）；start_id/end_id/offset 限定检索区间
 *   （意义同 recall：start_id 为基准边界，end_id 与 offset 二选一；end_id 优先）。
 * - 区间缺省（start_id 未提供）→ 检索全部消息；区间不合法（id 不存在等）→
 *   不报错，回退全量检索并在输出中明确告知（模型可见）。
 * - 向量：本地 ONNX embedding（embedding.ts，懒加载 + 批量）；相似度 = cosine。
 * - 输出：命中消息的 message_id/seq/类型 + 完整渲染文本 + 匹配说明（相似度、
 *   命中的关键词）；超大结果由 tool-result-pruner 裁剪（同 recall）。
 * - 仅主会话可用（subagent 拒绝，与 recall 一致）。
 */

import { z } from 'zod';
import { cosineSimilarity, type EmbedFn, getEmbedder } from './embedding.ts';
import { indexMessages, messageIdOfEvent } from './log-index.ts';
import type { Message, MessageIndex, ToolDefinition, ToolRunContext } from './types.ts';
import { isMainSession, renderMessageText } from './utils.ts';

/** recall-semantic 工具参数 schema：query 必填；top_k 默认 3（1-10）；区间参数均可选。 */
export const semanticRecallArgsSchema = z
  .object({
    query: z.string(),
    top_k: z.number().int().min(1).max(10).optional(),
    start_id: z.string().optional(),
    end_id: z.string().optional(),
    offset: z.number().optional(),
  })
  .refine((args) => args.query.trim().length > 0, {
    message: 'query 不能为空',
  });

/** recall-semantic 工具调用参数（由 semanticRecallArgsSchema 推断）。 */
export type SemanticRecallArgs = z.infer<typeof semanticRecallArgsSchema>;

/** 解析并校验参数：失败时抛出可读错误（普通 Error 而非 ZodError）。 */
export function parseSemanticRecallArgs(raw: unknown): SemanticRecallArgs {
  /** safeParse 结果。 */
  const result = semanticRecallArgsSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      result.error.issues
        .map((issue) => `${issue.path.join('.') || 'args'}:${issue.message}`)
        .join('; '),
    );
  }
  return result.data;
}

/** 区间解析结果：lo/hi 为消息序列下标（含）；fallback=true 表示区间无效已回退全量。 */
export type RangeResult = { lo: number; hi: number; fallback: boolean };

/**
 * 解析检索区间（消息序列下标，含端点）。
 * - start_id 未提供 → 全量（fallback=false）。
 * - start_id 提供：end_id/offset 计算终点（语义同 recall，end_id 优先）；
 *   start_id/end_id 不存在或区间为空 → fallback=true（全量 + 提示）。
 */
export function resolveSemanticRange(
  index: MessageIndex,
  args: Pick<SemanticRecallArgs, 'start_id' | 'end_id' | 'offset'>,
): RangeResult {
  const total = index.messages.length;
  if (total === 0) return { lo: 0, hi: -1, fallback: false };
  if (args.start_id === undefined) return { lo: 0, hi: total - 1, fallback: false };
  /** start_id 在消息序列中的下标。 */
  const start = index.byId.get(args.start_id);
  if (start === undefined) return { lo: 0, hi: total - 1, fallback: true };
  /** 终点下标（end_id 优先；否则 start + offset 取整）。 */
  let end: number;
  if (args.end_id !== undefined) {
    /** end_id 在消息序列中的下标。 */
    const found = index.byId.get(args.end_id);
    if (found === undefined) return { lo: 0, hi: total - 1, fallback: true };
    end = found;
  } else if (args.offset !== undefined) {
    /** 偏移步数（非有限数按 0；非整数 floor）。 */
    const step = Number.isFinite(args.offset) ? Math.floor(args.offset) : 0;
    end = start + step;
  } else {
    // start_id 提供但既无 end_id 也无 offset：仅检索该单条消息
    end = start;
  }
  /** 区间下界（钳制）。 */
  const lo = Math.max(0, Math.min(start, end));
  /** 区间上界（钳制）。 */
  const hi = Math.min(total - 1, Math.max(start, end));
  if (lo > hi) return { lo: 0, hi: total - 1, fallback: true };
  return { lo, hi, fallback: false };
}

/** 简易分词：按非字母数字切分为小写词元（匹配要点用，非检索核心）。 */
export function tokenize(text: string): Set<string> {
  /** 词元集合。 */
  const tokens = new Set<string>();
  for (const part of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (part.length > 0) tokens.add(part);
  }
  return tokens;
}

/** 命中消息的匹配说明行：相似度 + 与 query 共有的关键词（最多 8 个）。 */
export function matchExplanation(query: string, text: string, score: number): string {
  /** query 词元。 */
  const qTokens = tokenize(query);
  /** 命中消息文本词元。 */
  const mTokens = tokenize(text);
  /** 共有词元（交集，按 query 词序）。 */
  const shared: string[] = [];
  for (const token of qTokens) {
    if (mTokens.has(token)) shared.push(token);
    if (shared.length >= 8) break;
  }
  /** 关键词部分（无共有词则省略）。 */
  const keywords = shared.length > 0 ? `，命中关键词: ${shared.join(' ')}` : '';
  return `相似度 ${score.toFixed(3)}${keywords}`;
}

/** 构建 recall-semantic 工具定义（embedder 可注入，测试传替身；缺省用本地模型）。 */
export function buildSemanticRecallTool(options?: {
  getPruner?: () => unknown;
  embedder?: EmbedFn;
}): ToolDefinition {
  /** pruner 获取器（可选，裁剪超大工具结果）。 */
  const getPruner = options?.getPruner ?? (() => undefined);
  /** 嵌入函数（注入替身或懒加载本地模型）。 */
  const embed: EmbedFn = options?.embedder ?? ((texts) => getEmbedder().then((fn) => fn(texts)));
  return {
    name: 'recall-semantic',
    description:
      '按语义（自然语言含义）在会话全部消息中检索：用一句话描述你要找的内容（可混用中英文与代码术语）。返回最匹配的若干条完整消息、message_id 与匹配说明；如需精确定位某个 message_id 周边的消息，请再用 recall 工具。',
    parameters: {
      query: {
        type: 'string',
        description:
          '描述要找的内容的自然语言 query（可混用中英文与代码术语，如 "修复 retry backoff 的逻辑"）。',
        required: true,
      },
      top_k: {
        type: 'number',
        description: '返回最匹配的消息条数（1-10，默认 3）。',
      },
      start_id: {
        type: 'string',
        description:
          'message_id(uuid)，可选。限定检索区间：以该消息为基准边界（意义同 recall）。缺省检索全部消息。区间不合法时自动回退全量检索并在结果中说明。',
      },
      end_id: {
        type: 'string',
        description:
          'message_id(uuid)，可选，与 offset 互斥，限定区间的另一个边界（意义同 recall）。',
      },
      offset: {
        type: 'number',
        description:
          '可选，与 end_id 互斥。相对 start_id 的步数：正数向后、负数向前（意义同 recall）。',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: unknown, exec: ToolRunContext) {
      /** 解析并校验后的调用参数。 */
      const { query, top_k, start_id, end_id, offset } = parseSemanticRecallArgs(args);
      /** 当前会话。 */
      const session = exec.agent?.session;
      if (!session) return '会话异常';
      if (!isMainSession(session)) return 'recall-semantic 仅主会话可用';
      /** 会话消息索引（全部消息事件，含被压缩/遮蔽）。 */
      const index = indexMessages(session);
      if (index.messages.length === 0) return '会话中没有可检索的消息';
      /** 检索区间（消息序列下标；区间不合法时回退全量并标记）。 */
      const range = resolveSemanticRange(index, { start_id, end_id, offset });
      /** 候选消息渲染文本（区间内；跳过渲染失败/空文本）。 */
      const candidates: Array<{ node: (typeof index.messages)[number]; text: string }> = [];
      for (let i = range.lo; i <= range.hi; i += 1) {
        /** 当前消息节点。 */
        const node = index.messages[i];
        if (!node) continue;
        /** 节点对应的会话事件。 */
        const event = session.events[node.seq];
        if (!event) continue;
        /** 事件派生的消息对象。 */
        let message: Message | null = null;
        try {
          message = session.deriveEventMessage(event);
        } catch {
          /* 渲染失败的消息跳过 */
        }
        /** 渲染文本。 */
        const text = message ? renderMessageText(message) : '';
        if (text.trim().length > 0) candidates.push({ node, text });
      }
      if (candidates.length === 0) return '指定范围内没有可检索的消息';
      /** 查询向量（单条）。 */
      const [queryVec] = await embed([query]);
      if (!queryVec) return '语义检索失败：无法生成查询向量';
      /** 候选文本批量嵌入。 */
      const vectors = await embed(candidates.map((c) => c.text));
      /** 打分结果（相似度 + 候选）。 */
      const scored = candidates.map((c, i) => ({
        node: c.node,
        text: c.text,
        score: cosineSimilarity(queryVec, vectors[i] ?? new Float32Array(0)),
      }));
      scored.sort((a, b) => b.score - a.score);
      /** 返回条数（top_k 默认 3）。 */
      const limit = top_k ?? 3;
      const hits = scored.slice(0, limit);
      /** 结果缓冲。 */
      const parts: string[] = [];
      /** 范围描述（回退时明确告知模型）。 */
      const rangeNote = range.fallback
        ? '指定区间不合法（start_id/end_id 不存在等），已回退检索全部消息'
        : start_id === undefined
          ? `检索全部消息（${candidates.length} 条可嵌入）`
          : `检索区间 [${range.lo}..${range.hi}]（${candidates.length} 条可嵌入）`;
      parts.push(`查询: ${query}`);
      parts.push(rangeNote);
      parts.push(`匹配 TOP-${hits.length}（共 ${scored.length} 条候选）:`);
      for (let i = 0; i < hits.length; i += 1) {
        /** 当前命中。 */
        const hit = hits[i];
        if (!hit) continue;
        /** 消息事件（用于类型与 pruner）。 */
        const event = session.events[hit.node.seq];
        /** 命中消息的 id（缺失则省略）。 */
        const id = event ? (messageIdOfEvent(event) ?? '') : '';
        /** 命中消息文本（pruner 裁剪超大内容后渲染）。 */
        let text = hit.text;
        /** pruner（可选）。 */
        const pruner = getPruner() as
          | { pruneContent?: (blocks: readonly unknown[]) => unknown[] | null }
          | undefined;
        if (pruner?.pruneContent && event) {
          /** 事件派生的消息对象（裁剪用）。 */
          let message: Message | null = null;
          try {
            message = session.deriveEventMessage(event);
          } catch {
            /* 忽略 */
          }
          if (message) {
            /** 裁剪后的内容块。 */
            const pruned = pruner.pruneContent(message.content);
            if (pruned) text = renderMessageText({ ...message, content: pruned } as Message);
          }
        }
        parts.push(
          `-- [${i + 1}] seq ${hit.node.seq} ${hit.node.type} message_id=${id} — ${matchExplanation(query, hit.text, hit.score)} --`,
        );
        parts.push(text);
      }
      return parts.join('\n\n');
    },
  };
}
