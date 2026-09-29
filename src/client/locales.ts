/**
 * `om-compaction` namespace 字典：压缩卡片、降级警告与插件行配置页的中英文文案。
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
  'compaction.failed': '上下文压缩失败',
  'compaction.failed.observe': '上下文压缩失败（观察）',
  'compaction.failed.reflect': '上下文压缩失败（反思）',
  warning: '上下文压缩功能降级',
  'config.description': '配置上下文压缩与原文召回。',
  'config.loading': '正在加载配置…',
  'config.unavailable': '插件当前不可用，无法配置。',
  'config.readOnly': '本部署的配置只读。',
  'config.saveFailed': '保存失败，修改已保留，请检查配置或重试。',
  'config.versionConflict': '配置已被其他页面修改，请重新加载后再保存。',
  'config.save': '保存修改',
  'config.discard': '撤销修改',
  'config.saving': '保存中…',
  'config.overridden': '已覆盖',
  'config.inherited': '继承默认',
  'config.reset': '恢复默认',
  'config.invalidInteger': '请输入整数；留空使用默认值。',
  'config.observeThresholdTokens': '观察阈值',
  'config.observeThresholdTokens.hint': '上下文压力达到此 token 数时触发观察压缩。',
  'config.reflectThresholdTokens': '摘要合并阈值',
  'config.reflectThresholdTokens.hint': '摘要累计达到此 token 数时触发反思合并。',
  'config.tailMessageCount': '保留消息数',
  'config.tailMessageCount.hint': '触发观察后保留的完整消息条数。',
  'config.compressMaxTokens': '单次生成上限',
  'config.compressMaxTokens.hint': '压缩请求的最大生成 token 数；留空使用模型默认值。',
  'config.compressProvider': '压缩 Provider',
  'config.compressProvider.hint': '与压缩模型同时设置；留空使用会话路由。',
  'config.compressModel': '压缩模型',
  'config.compressModel.hint': '与压缩 Provider 同时设置；留空使用会话路由。',
  'config.compressReasoningEffort': '思考等级',
  'config.compressReasoningEffort.hint': '压缩请求的思考等级；留空使用模型默认值。',
  'config.compressSkipReasoning': '忽略思考内容',
  'config.compressSkipReasoning.hint': '压缩时不将历史 reasoning 纳入参考。',
  'config.rateLimitWaitMs': '限流等待毫秒数',
  'config.rateLimitWaitMs.hint': '429 限流后的冷却时间；0 表示不等待。',
  'config.modelDir': '嵌入模型目录',
  'config.modelDir.hint': '本地语义召回使用的嵌入模型目录。',
  'config.omEnabled': '自动压缩',
  'config.omEnabled.hint': '启用观察压缩和摘要反思合并。',
  'config.recallEnabled': '原文召回',
  'config.recallEnabled.hint': '注册按消息序号召回原文的工具。',
  'config.semanticRecallEnabled': '语义召回',
  'config.semanticRecallEnabled.hint': '注册本地语义检索工具。',
  'config.debug': '步骤日志',
  'config.debug.hint': '启用步骤级日志；缺省值由 NODE_ENV 决定。',
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
  'compaction.failed': 'Context compaction failed',
  'compaction.failed.observe': 'Context compaction failed (observation)',
  'compaction.failed.reflect': 'Context compaction failed (reflection)',
  warning: 'Context compaction degraded',
  'config.description': 'Configure context compaction and original-text recall.',
  'config.loading': 'Loading configuration…',
  'config.unavailable': 'This plugin is unavailable and cannot be configured.',
  'config.readOnly': 'This deployment stores configuration read-only.',
  'config.saveFailed': 'Save failed. Your changes are retained; check the values or retry.',
  'config.versionConflict': 'Configuration changed elsewhere. Reload before saving again.',
  'config.save': 'Save changes',
  'config.discard': 'Discard changes',
  'config.saving': 'Saving…',
  'config.overridden': 'Overridden',
  'config.inherited': 'Inherited default',
  'config.reset': 'Reset to default',
  'config.invalidInteger': 'Enter an integer; leave blank to use the default.',
  'config.observeThresholdTokens': 'Observation threshold',
  'config.observeThresholdTokens.hint': 'Context pressure in tokens that triggers observation.',
  'config.reflectThresholdTokens': 'Reflection threshold',
  'config.reflectThresholdTokens.hint': 'Total summary tokens that trigger reflection.',
  'config.tailMessageCount': 'Retained message count',
  'config.tailMessageCount.hint': 'Full messages retained after observation is triggered.',
  'config.compressMaxTokens': 'Generation limit',
  'config.compressMaxTokens.hint':
    'Maximum generated tokens per compression request; blank uses the model default.',
  'config.compressProvider': 'Compression provider',
  'config.compressProvider.hint': 'Set with the compression model; blank uses session routing.',
  'config.compressModel': 'Compression model',
  'config.compressModel.hint': 'Set with the compression provider; blank uses session routing.',
  'config.compressReasoningEffort': 'Reasoning effort',
  'config.compressReasoningEffort.hint':
    'Reasoning effort for compression; blank uses the model default.',
  'config.compressSkipReasoning': 'Skip reasoning',
  'config.compressSkipReasoning.hint': 'Exclude historical reasoning from compression references.',
  'config.rateLimitWaitMs': 'Rate-limit wait in milliseconds',
  'config.rateLimitWaitMs.hint': 'Cooldown after a 429 response; zero skips the wait.',
  'config.modelDir': 'Embedding model directory',
  'config.modelDir.hint': 'Directory containing the local semantic-recall embedding model.',
  'config.omEnabled': 'Automatic compaction',
  'config.omEnabled.hint': 'Enable observation and reflection of summaries.',
  'config.recallEnabled': 'Original-text recall',
  'config.recallEnabled.hint': 'Register the message-index recall tool.',
  'config.semanticRecallEnabled': 'Semantic recall',
  'config.semanticRecallEnabled.hint': 'Register the local semantic-search tool.',
  'config.debug': 'Step logs',
  'config.debug.hint': 'Log processing steps; the default follows NODE_ENV.',
};

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Compaction card copy owned by dsh-plugin-om. */
    'om-compaction': keyof typeof zh;
  }
}
