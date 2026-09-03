/**
 * `om-compaction` namespace 字典：插件压缩卡片的界面文案（zh/en）。
 * 导出 NS / zh / en；zh 为键集事实源，en 键集与 zh 一致。
 */

/** Dictionary namespace owned by this plugin. */
export const NS = 'om-compaction';

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  compaction: '上下文已压缩',
  'compaction.completed': '已压缩 {items} 条历史记录（约 {tokens} tokens）',
  'compaction.stats':
    '{items} 条 · {beforeChars} 字符（{beforeTokens} tokens）→ {afterChars} 字符（{afterTokens} tokens）',
  'compaction.expand': '点击查看压缩摘要',
  'compaction.unavailable': '压缩摘要不可用',
  'compaction.running': '正在压缩上下文…',
  'compaction.running.observe': '正在压缩上下文（观察）…',
  'compaction.running.reflect': '正在压缩上下文（反思）…',
  'compaction.retries': '重试 {count} 次',
} as const;

/** English dictionary（键集与 zh 一致）。 */
export const en: Record<keyof typeof zh, string> = {
  compaction: 'Context compacted',
  'compaction.completed': 'Compacted {items} messages (~{tokens} tokens)',
  'compaction.stats':
    '{items} msgs · {beforeChars} chars ({beforeTokens} tokens) → {afterChars} chars ({afterTokens} tokens)',
  'compaction.expand': 'Click to view summary',
  'compaction.unavailable': 'Summary unavailable',
  'compaction.running': 'Compressing context…',
  'compaction.running.observe': 'Compressing context (observation)…',
  'compaction.running.reflect': 'Compressing context (reflection)…',
  'compaction.retries': 'Retried {count} times',
};

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Compaction card copy owned by dsh-plugin-om. */
    'om-compaction': keyof typeof zh;
  }
}
