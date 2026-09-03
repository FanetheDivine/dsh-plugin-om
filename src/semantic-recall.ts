/**
 * recall-semantic 工具：按自然语言 query 对会话全部完整消息（含被压缩/遮蔽的）做语义
 * 检索，返回最匹配的完整消息与匹配说明。完整消息即 `用户消息`（user_message 中 kind 为 user
 * 的部分）、`系统消息`（user_message 中其余 kind 的部分）、`模型输出文本`和`具有result的
 * toolcall`；首条完整消息的 index 为 0，后续递增、会话内全局稳定。
 *
 * - 参数：query 必填；top_k（默认 3，1-10）；start/end/offset 限定检索区间
 *   （意义同 recall：start 为基准边界，end 与 offset 二选一；end 优先）。
 *   wire 参数 JSON Schema 由本 schema 经 toJSONSchema 生成（各字段描述来自 .describe()，
 *   见 json-schema.ts）。
 * - 区间缺省（start 未提供）→ 检索全部消息；区间不合法（start/end 越界等）→
 *   不报错，回退全量检索并在输出中明确告知（模型可见）。
 * - 向量：本地 ONNX embedding（embedding.ts，懒加载 + 批量）；相似度 = cosine。
 * - 匹配：只匹配文本（嵌入文本不含图片标注行）——图片内容不参与相似度，纯图片消息
 *   （无可渲染文本）不进候选池、无法命中；
 * - 输出：命中消息的 index/类型（toolcall 附调用 id）+ 完整渲染文本 + 匹配说明（相似度、
 *   命中的关键词）；命中消息携带的图片附件随结果保留（同 recall：文本段以 [图片附件：…]
 *   标注行提示、images 元数据经 output.render 投影为 image 内容块）；超大结果由
 *   tool-result-pruner 裁剪（同 recall）。
 * - 仅主会话可用（subagent 拒绝，与 recall 一致）。
 */

import { z } from 'zod';
import { COMPLETE_MESSAGE_DEFINITION } from './constants.ts';
import { cosineSimilarity, type EmbedFn, getEmbedder, type ModelStatus } from './embedding.ts';
import { parametersFromZod } from './json-schema.ts';
import {
  indexCompleteMessages,
  type PrunerLike,
  renderCompleteMessage,
  renderCompleteMessageParts,
} from './log-index.ts';
import {
  type ImageRefValue,
  imageNote,
  RECALL_OUTPUT_SCHEMA,
  type RecallOutputValue,
  renderRecallOutput,
  textOnly,
} from './recall-output.ts';
import type { CompleteMessage, ToolDefinition, ToolRunContext } from './types.ts';
import { isMainSession } from './utils.ts';

/** recall-semantic 工具参数 schema：query 必填；top_k 默认 3（1-10）；区间参数均可选。 */
export const semanticRecallArgsSchema = z
  .object({
    query: z
      .string()
      .describe(
        '描述要找的内容的自然语言 query（可混用中英文与代码术语，如 "修复 retry backoff 的逻辑"），不能为空。',
      ),
    top_k: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe('返回最匹配的完整消息条数（1-10，默认 3）。'),
    start: z
      .number()
      .optional()
      .describe('完整消息序号（index），可选。作为基准边界，和end或offset配合，指定搜索区间。'),
    end: z
      .number()
      .optional()
      .describe('必须和start配合使用，与 offset 互斥，指定搜索区间的另一个边界。'),
    offset: z
      .number()
      .optional()
      .describe('必须和start配合使用，与 end 互斥。相对 start 的步数：正数向后、负数向前。'),
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

/** 区间解析结果：lo/hi 为完整消息 index（含）；fallback=true 表示区间无效已回退全量。 */
export type RangeResult = { lo: number; hi: number; fallback: boolean };

/**
 * 解析检索区间（完整消息 index，含端点）。
 * - start 未提供 → 全量（fallback=false）。
 * - start 提供：end/offset 计算终点（语义同 recall，end 优先）；
 *   start/end 越界或区间为空 → fallback=true（全量 + 提示）。
 */
export function resolveSemanticRange(
  total: number,
  args: Pick<SemanticRecallArgs, 'start' | 'end' | 'offset'>,
): RangeResult {
  if (total <= 0) return { lo: 0, hi: -1, fallback: false };
  if (args.start === undefined) return { lo: 0, hi: total - 1, fallback: false };
  /** start 取整（非有限数按 -1 处理，走越界回退）。 */
  const start = Number.isFinite(args.start) ? Math.floor(args.start) : -1;
  if (start < 0 || start >= total) return { lo: 0, hi: total - 1, fallback: true };
  /** 终点 index（end 优先；否则 start + offset 取整）。 */
  let end: number;
  if (args.end !== undefined) {
    /** end 取整（非有限数按 -1 处理，走越界回退）。 */
    const found = Number.isFinite(args.end) ? Math.floor(args.end) : -1;
    if (found < 0 || found >= total) return { lo: 0, hi: total - 1, fallback: true };
    end = found;
  } else if (args.offset !== undefined) {
    /** 偏移步数（非有限数按 0；非整数 floor）。 */
    const step = Number.isFinite(args.offset) ? Math.floor(args.offset) : 0;
    end = start + step;
  } else {
    // start 提供但既无 end 也无 offset：仅检索该单条完整消息
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

/** 模型未就绪时返回给模型的文案（告知即可；下载完成后无需另行通知，直接再次调用）。 */
export const SEMANTIC_MODEL_NOT_READY_MESSAGE = '语义检索暂不可用，本地向量模型尚未就绪。';

/** 构建 recall-semantic 工具定义（embedder/modelStatus 可注入，测试传替身；缺省用本地模型）。 */
export function buildSemanticRecallTool(options?: {
  getPruner?: () => unknown;
  embedder?: EmbedFn;
  /** 模型就绪检查（缺省视为已就绪；未就绪时返回告知文案而非报错）。 */
  modelStatus?: () => ModelStatus | Promise<ModelStatus>;
}): ToolDefinition {
  /** pruner 获取器（可选，裁剪超大工具结果）。 */
  const getPruner = options?.getPruner ?? (() => undefined);
  /** 嵌入函数（注入替身或懒加载本地模型）。 */
  const embed: EmbedFn = options?.embedder ?? ((texts) => getEmbedder().then((fn) => fn(texts)));
  return {
    name: 'recall-semantic',
    description: `${COMPLETE_MESSAGE_DEFINITION}此工具可以按自然语言含义，检索最符合的完整消息。默认在全消息范围搜索，可以指定区间。注意：语义检索只匹配文本，图片内容不参与匹配（纯图片消息无法命中，也不能按图片内容检索）；命中的完整消息携带的图片附件随结果保留（文本段以 [图片附件：…] 标注，随后附 image 内容块），与 recall 相同。`,
    parameters: parametersFromZod(semanticRecallArgsSchema),
    output: {
      schema: RECALL_OUTPUT_SCHEMA,
      render: (_args, value) => renderRecallOutput(value as RecallOutputValue),
    },
    async execute(args: unknown, exec: ToolRunContext): Promise<RecallOutputValue> {
      /** 解析并校验后的调用参数。 */
      const { query, top_k, start, end, offset } = parseSemanticRecallArgs(args);
      /** 当前会话。 */
      const session = exec.agent?.session;
      if (!session) return textOnly('会话异常');
      if (!isMainSession(session)) return textOnly('recall-semantic 仅主会话可用');
      /** 模型就绪检查（缺省视为就绪，向后兼容；未就绪时告知模型，不阻塞等待下载）。 */
      const status = (await options?.modelStatus?.()) ?? 'ready';
      if (status !== 'ready') return textOnly(SEMANTIC_MODEL_NOT_READY_MESSAGE);
      /** 完整消息索引（全部事件，含被压缩/遮蔽）。 */
      const cms = indexCompleteMessages(session);
      if (cms.length === 0) return textOnly('会话中没有可检索的消息');
      /** 检索区间（完整消息 index；区间不合法时回退全量并标记）。 */
      const range = resolveSemanticRange(cms.length, { start, end, offset });
      /** 候选完整消息渲染文本（区间内；跳过渲染失败/空文本）。 */
      const candidates: Array<{ cm: CompleteMessage; text: string }> = [];
      for (let i = range.lo; i <= range.hi; i += 1) {
        /** 当前完整消息。 */
        const cm = cms[i];
        if (!cm) continue;
        /** 渲染文本（嵌入用完整文本，输出时再裁剪）。 */
        let text = '';
        try {
          text = renderCompleteMessage(session, cm);
        } catch {
          /* 渲染失败的完整消息跳过 */
        }
        if (text.trim().length > 0) candidates.push({ cm, text });
      }
      if (candidates.length === 0) return textOnly('指定范围内没有可检索的消息');
      /** 查询向量（单条）。 */
      const [queryVec] = await embed([query]);
      if (!queryVec) return textOnly('语义检索失败：无法生成查询向量');
      /** 候选文本批量嵌入。 */
      const vectors = await embed(candidates.map((c) => c.text));
      /** 打分结果（相似度 + 候选）。 */
      const scored = candidates.map((c, i) => ({
        cm: c.cm,
        text: c.text,
        score: cosineSimilarity(queryVec, vectors[i] ?? new Float32Array(0)),
      }));
      scored.sort((a, b) => b.score - a.score);
      /** 返回条数（top_k 默认 3）。 */
      const limit = top_k ?? 3;
      const hits = scored.slice(0, limit);
      /** 结果缓冲。 */
      const parts: string[] = [];
      /** 命中消息收集的图片附件（按命中顺序，供 render 投影为 image 块）。 */
      const images: ImageRefValue[] = [];
      /** 范围描述（回退时明确告知模型）。 */
      const rangeNote = range.fallback
        ? '指定区间不合法（start/end 越界等），已回退检索全部消息'
        : start === undefined
          ? `检索全部消息（${candidates.length} 条可嵌入）`
          : `检索区间 [${range.lo}..${range.hi}]（${candidates.length} 条可嵌入）`;
      parts.push(`查询: ${query}`);
      parts.push(rangeNote);
      parts.push(`匹配 TOP-${hits.length}（共 ${scored.length} 条候选）:`);
      for (let i = 0; i < hits.length; i += 1) {
        /** 当前命中。 */
        const hit = hits[i];
        if (!hit) continue;
        /** 类型标注（toolcall 附调用 id，与 recall 输出一致）。 */
        const callAttr =
          hit.cm.type === 'toolcall' && hit.cm.callId ? ` callId=${hit.cm.callId}` : '';
        /** 输出文本与图片（pruner 裁剪超大内容；裁剪失败保留嵌入用文本）。 */
        let text = hit.text;
        /** 命中消息携带的图片附件（渲染失败时无）。 */
        let hitImages: ImageRefValue[] = [];
        try {
          /** tool-result-pruner（可选）。 */
          const pruner = getPruner() as PrunerLike | undefined;
          /** 渲染结果（文本 + 图片元数据）。 */
          const rendered = renderCompleteMessageParts(session, hit.cm, pruner);
          text = rendered.text;
          hitImages = rendered.images;
        } catch {
          /* 保留嵌入用文本 */
        }
        parts.push(
          `-- [${i + 1}] index ${hit.cm.index} ${hit.cm.type}${callAttr} — ${matchExplanation(query, hit.text, hit.score)} --`,
        );
        // 带图时在文本后追加标注行，帮助模型对应随后的 image 块
        parts.push(hitImages.length > 0 ? [text, ...hitImages.map(imageNote)].join('\n') : text);
        images.push(...hitImages);
      }
      return { text: parts.join('\n\n'), images };
    },
  };
}
