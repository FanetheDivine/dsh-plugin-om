/**
 * recall 的 query 检索实现：对会话全部完整消息（含被压缩/遮蔽的）检索，返回最匹配的
 * 完整消息与匹配说明。
 * 导出 SemanticOptions / RangeArgs / resolveSemanticRange / tokenize / matchExplanation /
 * keywordTerms / SEMANTIC_MODEL_NOT_READY_MESSAGE / semanticSearch / keywordSearch。
 * - 语义检索：本地 ONNX 嵌入（cosine 相似度）
 * - 字符串匹配（语义增强关闭时）：query 按空白拆词，不区分大小写计命中词数，同分时
 *   index 大的优先，零命中不返回
 * 只匹配文本，纯图片消息不进候选池；
 * 区间缺省检索全部、区间不合法回退全量并在输出中告知；输出契约同 recall
 * （{ text, images }，条目为 XML 形态见 recall-xml.ts，超大结果由 tool-result-pruner
 * 裁剪）；候选池排除本次调用自身的 toolcall 完整消息（其渲染文本含 query 原文，
 * 必居榜首）。工具入口与参数校验见 recall.ts。
 */

import { cosineSimilarity, type EmbedFn, getEmbedder, type ModelStatus } from './embedding.ts';
import { indexCompleteMessages, type PrunerLike, renderCompleteMessage } from './log-index.ts';
import { type ImageRefValue, type RecallOutputValue, textOnly } from './recall-output.ts';
import { renderCompleteMessageXml, xmlCommentText } from './recall-xml.ts';
import type { CompleteMessage, Session } from './types.ts';

/** 语义增强的可注入依赖（测试传替身；缺省用本地模型）。 */
export type SemanticOptions = {
  embedder?: EmbedFn;
  /** 模型就绪检查（缺省视为已就绪；未就绪时返回告知文案而非报错）。 */
  modelStatus?: () => ModelStatus | Promise<ModelStatus>;
};

/** 检索区间参数（完整消息 index）。 */
export type RangeArgs = {
  start?: number | undefined;
  end?: number | undefined;
  offset?: number | undefined;
};

/** 区间解析结果：lo/hi 为完整消息 index（含）；fallback=true 表示区间无效已回退全量。 */
export type RangeResult = { lo: number; hi: number; fallback: boolean };

/**
 * 解析检索区间（完整消息 index，含端点）。
 * start 未提供 → 全量（fallback=false）；start/end 越界或区间为空 → fallback=true
 * （回退全量并在输出中告知）。
 */
export function resolveSemanticRange(total: number, args: RangeArgs): RangeResult {
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

/** 语义检索入参：query 与区间由 recall 校验后传入。 */
export type SemanticSearchInput = RangeArgs & {
  session: Session;
  query: string;
  /** 返回条数（1-10，缺省 3）。 */
  topK?: number | undefined;
  /** 本次调用自身的 callId，其 toolcall 不进候选池。 */
  selfCallId: string;
  getPruner: () => unknown;
  options?: SemanticOptions | undefined;
};

/** 检索候选：完整消息与其渲染文本。 */
type Candidate = { cm: CompleteMessage; text: string };

/** 收集区间内可检索的候选；会话为空或区间内无候选时返回提示文案。 */
function collectCandidates(
  input: SemanticSearchInput,
): { candidates: Candidate[]; range: RangeResult } | string {
  const { session, start, end, offset, selfCallId } = input;
  const cms = indexCompleteMessages(session);
  if (cms.length === 0) return '会话中没有可检索的消息';
  const range = resolveSemanticRange(cms.length, { start, end, offset });
  const candidates: Candidate[] = [];
  for (let i = range.lo; i <= range.hi; i += 1) {
    const cm = cms[i];
    if (!cm) continue;
    // 排除本次调用自身：其渲染文本含 query 原文，相似度必居榜首，只会挤占 top_k 名额
    if (selfCallId !== '' && cm.type === 'toolcall' && cm.callId === selfCallId) continue;
    let text = '';
    try {
      text = renderCompleteMessage(session, cm);
    } catch {
      /* 渲染失败的完整消息跳过 */
    }
    if (text.trim().length > 0) candidates.push({ cm, text });
  }
  if (candidates.length === 0) return '指定范围内没有可检索的消息';
  return { candidates, range };
}

/** 在会话完整消息中做语义检索，返回 TOP-K 命中条目。 */
export async function semanticSearch(input: SemanticSearchInput): Promise<RecallOutputValue> {
  const { query, topK, options } = input;
  const embed: EmbedFn = options?.embedder ?? ((texts) => getEmbedder().then((fn) => fn(texts)));
  const status = (await options?.modelStatus?.()) ?? 'ready';
  if (status !== 'ready') return textOnly(SEMANTIC_MODEL_NOT_READY_MESSAGE);
  const collected = collectCandidates(input);
  if (typeof collected === 'string') return textOnly(collected);
  const { candidates, range } = collected;
  const [queryVec] = await embed([query]);
  if (!queryVec) return textOnly('语义检索失败：无法生成查询向量');
  const vectors = await embed(candidates.map((c) => c.text));
  const scored = candidates.map((c, i) => ({
    cm: c.cm,
    text: c.text,
    score: cosineSimilarity(queryVec, vectors[i] ?? new Float32Array(0)),
  }));
  scored.sort((a, b) => b.score - a.score);
  const hits = scored.slice(0, topK ?? 3).map((hit) => ({
    ...hit,
    explanation: matchExplanation(query, hit.text, hit.score),
  }));
  return renderHits(input, range, `${candidates.length} 条可嵌入`, scored.length, hits);
}

/** 字符串匹配的检索词：query 按空白拆分、转小写、去重。 */
export function keywordTerms(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/\s+/u)
        .filter((term) => term.length > 0),
    ),
  ];
}

/** 在会话完整消息中按字符串匹配检索（语义增强关闭时），返回 TOP-K 命中条目。 */
export function keywordSearch(input: SemanticSearchInput): RecallOutputValue {
  const terms = keywordTerms(input.query);
  if (terms.length === 0) return textOnly('query 不能为空');
  const collected = collectCandidates(input);
  if (typeof collected === 'string') return textOnly(collected);
  const { candidates, range } = collected;
  const scored = candidates
    .map((c) => {
      const lower = c.text.toLowerCase();
      const matched = terms.filter((term) => lower.includes(term));
      return { ...c, score: matched.length, matched };
    })
    .filter((c) => c.score > 0);
  if (scored.length === 0) {
    return textOnly(`未找到包含 ${terms.join(' ')} 中任一词的消息（字符串匹配，不区分大小写）`);
  }
  scored.sort((a, b) => b.score - a.score || b.cm.index - a.cm.index);
  const hits = scored.slice(0, input.topK ?? 3).map((hit) => ({
    ...hit,
    explanation: `命中 ${hit.score}/${terms.length} 个词: ${hit.matched.join(' ')}`,
  }));
  return renderHits(input, range, `${candidates.length} 条，字符串匹配`, scored.length, hits);
}

/** 渲染命中条目：查询与检索说明以 XML 注释置于条目之前，每条命中前附匹配说明。 */
function renderHits(
  input: SemanticSearchInput,
  range: RangeResult,
  poolNote: string,
  total: number,
  hits: ReadonlyArray<Candidate & { explanation: string }>,
): RecallOutputValue {
  const { session, query, start, getPruner } = input;
  const parts: string[] = [];
  const images: ImageRefValue[] = [];
  const rangeNote = range.fallback
    ? '指定区间不合法（start/end 越界等），已回退检索全部消息'
    : start === undefined
      ? `检索全部消息（${poolNote}）`
      : `检索区间 [${range.lo}..${range.hi}]（${poolNote}）`;
  parts.push(`<!-- ${xmlCommentText(`查询: ${query}`)} -->`);
  parts.push(`<!-- ${xmlCommentText(rangeNote)} -->`);
  parts.push(`<!-- ${xmlCommentText(`匹配 TOP-${hits.length}（共 ${total} 条候选）`)} -->`);
  for (let i = 0; i < hits.length; i += 1) {
    const hit = hits[i];
    if (!hit) continue;
    const note = `<!-- ${xmlCommentText(`${i + 1}. ${hit.explanation}`)} -->`;
    let xml: string;
    let hitImages: ImageRefValue[] = [];
    try {
      const pruner = getPruner() as PrunerLike | undefined;
      const rendered = renderCompleteMessageXml(session, hit.cm, {
        pruner,
        fallbackText: hit.text,
      });
      xml = rendered.xml;
      hitImages = rendered.images;
    } catch {
      // 回退元素也构建失败时降级为纯文本正文（嵌入用文本）
      xml = hit.text;
    }
    parts.push(note);
    parts.push(xml);
    images.push(...hitImages);
  }
  return { text: parts.join('\n'), images };
}
