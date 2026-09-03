/**
 * recall-semantic 工具：按自然语言 query 对会话全部完整消息（含被压缩/遮蔽的）做
 * 语义检索，返回最匹配的完整消息与匹配说明。
 * 导出 semanticRecallArgsSchema / SemanticRecallArgs / parseSemanticRecallArgs /
 * resolveSemanticRange / tokenize / matchExplanation / buildSemanticRecallTool。
 * 向量为本地 ONNX 嵌入（cosine 相似度）；只匹配文本，纯图片消息不进候选池；
 * 区间缺省检索全部、区间不合法回退全量并在输出中告知；输出契约同 recall
 * （{ text, images }，超大结果由 tool-result-pruner 裁剪）；仅主会话可用。
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
 * start 未提供 → 全量（fallback=false）；start/end 越界或区间为空 → fallback=true
 * （回退全量并在输出中告知）。
 */
export function resolveSemanticRange(
  total: number,
  args: Pick<SemanticRecallArgs, 'start' | 'end' | 'offset'>,
): RangeResult {
  if (total <= 0) return { lo: 0, hi: -1, fallback: false };
  if (args.start === undefined) return { lo: 0, hi: total - 1, fallback: false };
  const start = Number.isFinite(args.start) ? Math.floor(args.start) : -1;
  if (start < 0 || start >= total) return { lo: 0, hi: total - 1, fallback: true };
  let end: number;
  if (args.end !== undefined) {
    const found = Number.isFinite(args.end) ? Math.floor(args.end) : -1;
    if (found < 0 || found >= total) return { lo: 0, hi: total - 1, fallback: true };
    end = found;
  } else if (args.offset !== undefined) {
    const step = Number.isFinite(args.offset) ? Math.floor(args.offset) : 0;
    end = start + step;
  } else {
    // start 提供但既无 end 也无 offset：仅检索该单条完整消息
    end = start;
  }
  const lo = Math.max(0, Math.min(start, end));
  const hi = Math.min(total - 1, Math.max(start, end));
  if (lo > hi) return { lo: 0, hi: total - 1, fallback: true };
  return { lo, hi, fallback: false };
}

/** 简易分词：按非字母数字切分为小写词元（匹配要点用，非检索核心）。 */
export function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const part of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (part.length > 0) tokens.add(part);
  }
  return tokens;
}

/** 命中消息的匹配说明行：相似度 + 与 query 共有的关键词（最多 8 个）。 */
export function matchExplanation(query: string, text: string, score: number): string {
  const qTokens = tokenize(query);
  const mTokens = tokenize(text);
  const shared: string[] = [];
  for (const token of qTokens) {
    if (mTokens.has(token)) shared.push(token);
    if (shared.length >= 8) break;
  }
  const keywords = shared.length > 0 ? `，命中关键词: ${shared.join(' ')}` : '';
  return `相似度 ${score.toFixed(3)}${keywords}`;
}

/** 模型未就绪时返回给模型的文案（下载完成后直接再次调用即可）。 */
export const SEMANTIC_MODEL_NOT_READY_MESSAGE = '语义检索暂不可用，本地向量模型尚未就绪。';

/** 构建 recall-semantic 工具定义（embedder/modelStatus 可注入，测试传替身；缺省用本地模型）。 */
export function buildSemanticRecallTool(options?: {
  getPruner?: () => unknown;
  embedder?: EmbedFn;
  /** 模型就绪检查（缺省视为已就绪；未就绪时返回告知文案而非报错）。 */
  modelStatus?: () => ModelStatus | Promise<ModelStatus>;
}): ToolDefinition {
  const getPruner = options?.getPruner ?? (() => undefined);
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
      const { query, top_k, start, end, offset } = parseSemanticRecallArgs(args);
      const session = exec.agent?.session;
      if (!session) return textOnly('会话异常');
      if (!isMainSession(session)) return textOnly('recall-semantic 仅主会话可用');
      const status = (await options?.modelStatus?.()) ?? 'ready';
      if (status !== 'ready') return textOnly(SEMANTIC_MODEL_NOT_READY_MESSAGE);
      const cms = indexCompleteMessages(session);
      if (cms.length === 0) return textOnly('会话中没有可检索的消息');
      const range = resolveSemanticRange(cms.length, { start, end, offset });
      const candidates: Array<{ cm: CompleteMessage; text: string }> = [];
      for (let i = range.lo; i <= range.hi; i += 1) {
        const cm = cms[i];
        if (!cm) continue;
        let text = '';
        try {
          text = renderCompleteMessage(session, cm);
        } catch {
          /* 渲染失败的完整消息跳过 */
        }
        if (text.trim().length > 0) candidates.push({ cm, text });
      }
      if (candidates.length === 0) return textOnly('指定范围内没有可检索的消息');
      const [queryVec] = await embed([query]);
      if (!queryVec) return textOnly('语义检索失败：无法生成查询向量');
      const vectors = await embed(candidates.map((c) => c.text));
      const scored = candidates.map((c, i) => ({
        cm: c.cm,
        text: c.text,
        score: cosineSimilarity(queryVec, vectors[i] ?? new Float32Array(0)),
      }));
      scored.sort((a, b) => b.score - a.score);
      const limit = top_k ?? 3;
      const hits = scored.slice(0, limit);
      const parts: string[] = [];
      const images: ImageRefValue[] = [];
      const rangeNote = range.fallback
        ? '指定区间不合法（start/end 越界等），已回退检索全部消息'
        : start === undefined
          ? `检索全部消息（${candidates.length} 条可嵌入）`
          : `检索区间 [${range.lo}..${range.hi}]（${candidates.length} 条可嵌入）`;
      parts.push(`查询: ${query}`);
      parts.push(rangeNote);
      parts.push(`匹配 TOP-${hits.length}（共 ${scored.length} 条候选）:`);
      for (let i = 0; i < hits.length; i += 1) {
        const hit = hits[i];
        if (!hit) continue;
        const callAttr =
          hit.cm.type === 'toolcall' && hit.cm.callId ? ` callId=${hit.cm.callId}` : '';
        let text = hit.text;
        let hitImages: ImageRefValue[] = [];
        try {
          const pruner = getPruner() as PrunerLike | undefined;
          const rendered = renderCompleteMessageParts(session, hit.cm, pruner);
          text = rendered.text;
          hitImages = rendered.images;
        } catch {
          /* 保留嵌入用文本 */
        }
        parts.push(
          `-- [${i + 1}] index ${hit.cm.index} ${hit.cm.type}${callAttr} — ${matchExplanation(query, hit.text, hit.score)} --`,
        );
        parts.push(hitImages.length > 0 ? [text, ...hitImages.map(imageNote)].join('\n') : text);
        images.push(...hitImages);
      }
      return { text: parts.join('\n\n'), images };
    },
  };
}
