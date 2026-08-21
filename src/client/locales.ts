/**
 * `om-compaction` namespace dictionaries: 插件压缩卡片的界面文案。
 *
 * 与宿主 conversation 命名空间分离（独立 NS），插件卡片走自己的 keyed 渲染器，
 * 文案键不与对话插件的键冲突。
 */

/** Dictionary namespace owned by this plugin. */
export const NS = 'om-compaction';

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  compaction: '上下文已压缩',
  'compaction.completed': '已压缩 {items} 条历史记录（约 {tokens} tokens）',
  'compaction.stats': '压缩前 {items} 条消息 · {beforeChars} 字符 → 压缩后 {afterChars} 字符',
  'compaction.expand': '点击查看压缩摘要',
  'compaction.unavailable': '压缩摘要不可用',
} as const;

/** English dictionary（键集与 zh 一致）。 */
export const en: Record<keyof typeof zh, string> = {
  compaction: 'Context compacted',
  'compaction.completed': 'Compacted {items} messages (~{tokens} tokens)',
  'compaction.stats': '{items} messages · {beforeChars} chars before → {afterChars} chars after',
  'compaction.expand': 'Click to view summary',
  'compaction.unavailable': 'Summary unavailable',
};

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Compaction card copy owned by dsh-plugin-om. */
    'om-compaction': keyof typeof zh;
  }
}
