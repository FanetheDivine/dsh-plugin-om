/**
 * 压缩卡片业务定义：认领插件自产的压缩生命周期事件与替换检查点，
 * 聚合出可渲染的摘要卡片节点。
 *
 * 宿主 conversation 客户端仅识别 source.plugin === 'compact' 的压缩检查点
 * （ui-conversation 的 compactionDefinition），插件自产的检查点标记为
 * PLUGIN_LABEL（'dsh-plugin-om'），由本定义认领。生命周期事件（compaction/start
 * |summary|end）同时会被宿主的 compactionDefinition 匹配，但宿主没有检查点证据
 * 时不产出节点（buildViewNode 返回 null），因此双方共存无视觉冲突。
 */

import type {
  ConversationMatch,
  ConversationNodeContext,
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client';
import type { ChatNode, ChatNodeDataMap } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type {} from '@deepseek-ai/dsh-compaction/types';
import type { SessionEvent } from '@deepseek-ai/dsh-session/types';
import { PLUGIN_LABEL } from '../constants.ts';
import type { CompactionSummaryPayload } from '../types.ts';

/** 压缩卡片渲染器分发键（合并进 ChatNodeDataMap）。 */
export const COMPACTION_CARD_KIND = 'om-compaction';

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** dsh-plugin-om 压缩替换检查点渲染的摘要卡片数据。 */
    'om-compaction': OmCompactionChatData;
  }
}

/** 压缩卡片载荷：摘要文本与遮蔽统计（seq/time 由节点本体提供，不重复存放）。 */
export interface OmCompactionChatData {
  /** compaction/summary 的文本摘要；窗口裁剪把该事件留在窗外时为 null（卡片不可展开）。 */
  readonly summary: string | null;
  /** 已载入的 compaction/summary 事件 seq，窗外时为 null。 */
  readonly summaryEventSeq: number | null;
  /** 被遮蔽的表层节点数，summary 事件缺失或载荷非法时为 null。 */
  readonly shadowedItemCount: number | null;
  /** 遮蔽的 token 数，summary 事件缺失或载荷非法时为 null。 */
  readonly shadowedTokenCount: number | null;
  /** 压缩前的字符数（被压缩内容文本长度合计），载荷缺失或非法时为 null。 */
  readonly shadowedCharCount: number | null;
  /** 压缩后的字符数（摘要文本长度），summary 不可用或非法时为 null。 */
  readonly summaryCharCount: number | null;
  /** 压缩后的估算 token 数（4 字符 ≈ 1 token，与服务端 estimateTextTokens 同一启发式），summary 不可用或非法时为 null。 */
  readonly summaryTokenCount: number | null;
}

/** 压缩生命周期关联状态：summary / checkpoint 事件证据。 */
interface OmCompactionState {
  readonly summary?: ConversationMatch;
  readonly checkpoint?: ConversationMatch;
}

/**
 * replace-surface 判定：surfaceOp 为 { op: 'replace' } 对象（与宿主 runtime 的
 * isReplacementSurfaceEvent 同义）。宿主该助手位于浏览器 bundle 内
 * （window.__ModuleLoader__ 闭包），node 端测试无法求值，故本地实现同一形状检查。
 */
function isReplacementSurface(event: SessionEvent): boolean {
  const surfaceOp = (event as { surfaceOp?: unknown }).surfaceOp;
  return (
    typeof surfaceOp === 'object' &&
    surfaceOp !== null &&
    (surfaceOp as { op?: unknown }).op === 'replace'
  );
}

/**
 * 从压缩替换检查点（user/message + replace surface + source.plugin 为本插件）
 * 读取关联 identity。宿主的 'compact' 检查点由宿主自己渲染，本插件不认领，
 * 避免同一压缩出现两张卡片。
 */
export function checkpointCompactionId(event: SessionEvent): string | undefined {
  if (event.type !== 'user/message' || !isReplacementSurface(event)) return undefined;
  const data = event.data as unknown as {
    source?: { kind?: unknown; plugin?: unknown; compactionId?: unknown };
  };
  const source = data.source;
  if (
    source === undefined ||
    source.kind !== 'plugin' ||
    source.plugin !== PLUGIN_LABEL ||
    typeof source.compactionId !== 'string'
  ) {
    return undefined;
  }
  return source.compactionId;
}

/** 从 compaction/summary 载荷提取摘要文本与遮蔽统计（载荷非法时各字段回落 null）。 */
function compactSummaryData(summaryMatch: ConversationMatch | undefined): OmCompactionChatData {
  let summary: string | null = null;
  let shadowedItemCount: number | null = null;
  let shadowedTokenCount: number | null = null;
  let shadowedCharCount: number | null = null;
  if (summaryMatch?.event.type === 'compaction/summary') {
    // 宿主载荷类型是 union 且不含插件扩展字段，读取处收窄为插件扩展类型
    const data = summaryMatch.event.data as CompactionSummaryPayload;
    if (Array.isArray(data.summary)) {
      const text = data.summary.map((block) => (block.type === 'text' ? block.text : '')).join('');
      summary = text.trim() === '' ? null : text;
    }
    shadowedItemCount =
      Array.isArray(data.shadowedSeqs) &&
      data.shadowedSeqs.every((seq) => Number.isSafeInteger(seq) && seq >= 0)
        ? data.shadowedSeqs.length
        : null;
    shadowedTokenCount =
      Number.isSafeInteger(data.shadowedTokenCount) && data.shadowedTokenCount >= 0
        ? data.shadowedTokenCount
        : null;
    shadowedCharCount =
      data.shadowedCharCount !== undefined &&
      Number.isSafeInteger(data.shadowedCharCount) &&
      data.shadowedCharCount >= 0
        ? data.shadowedCharCount
        : null;
  }
  return {
    summary,
    summaryEventSeq: summaryMatch?.event.seq ?? null,
    shadowedItemCount,
    shadowedTokenCount,
    shadowedCharCount,
    summaryCharCount: summary === null ? null : summary.length,
    summaryTokenCount: summary === null ? null : Math.ceil(summary.length / 4),
  };
}

/** 窗口只载入检查点（生命周期事件在窗外）时的回落证据扫描。 */
function fallbackState(context: ConversationNodeContext<OmCompactionState>): OmCompactionState {
  const summary = context.matches.find((match) => match.event.type === 'compaction/summary');
  const checkpoint = context.matches.find(
    (match) => checkpointCompactionId(match.event) !== undefined,
  );
  return {
    ...(summary === undefined ? {} : { summary }),
    ...(checkpoint === undefined ? {} : { checkpoint }),
  };
}

/** 构建最终 Chat 目标节点（与 ui-conversation 的 chatNode 助手同构）。 */
function chatNode<Kind extends keyof ChatNodeDataMap & string>(
  context: ConversationNodeContext,
  kind: Kind,
  anchorSeq: number,
  data: ChatNodeDataMap[Kind],
): ChatNode<Kind> {
  return {
    key: context.key,
    kind,
    id: context.id,
    target: 'chat',
    anchorSeq,
    location: context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' },
    visibility: 'visible',
    data,
  };
}

/**
 * 插件压缩生命周期定义：compaction/start 开启上下文，summary / 替换检查点 /
 * end 作为 update 折叠证据；仅在存在替换检查点时产出卡片节点。
 */
export const omCompactionDefinition: ConversationNodeDefinition<OmCompactionState> = {
  kind: COMPACTION_CARD_KIND,
  target: 'chat',
  match: (event) => {
    const compactionId = checkpointCompactionId(event);
    if (compactionId !== undefined) return { id: compactionId, role: 'update' };
    if (
      event.type === 'compaction/start' ||
      event.type === 'compaction/summary' ||
      event.type === 'compaction/end'
    ) {
      const id: unknown = event.data.compactionId;
      if (typeof id !== 'string' || id === '') return null;
      return { id, role: event.type === 'compaction/start' ? 'start' : 'update' };
    }
    return null;
  },
  start: () => ({}),
  update: (context, match) => {
    if (match.event.type === 'compaction/summary') return { ...context.state, summary: match };
    if (checkpointCompactionId(match.event) !== undefined)
      return { ...context.state, checkpoint: match };
    return context.state;
  },
  buildViewNode: (context) => {
    const state = context.state ?? fallbackState(context);
    if (state.checkpoint === undefined) return null;
    const data = compactSummaryData(state.summary);
    return chatNode(context, COMPACTION_CARD_KIND, state.checkpoint.event.seq, data);
  },
};
