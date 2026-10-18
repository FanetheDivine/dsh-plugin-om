# Changelog

## [0.0.60] - 2026-10-18

## Unreleased

## Changes

- docs: agent-workflow skill 第 1 步模糊化 worktree 创建方式，保留 gh 与 pnpm 命令示例。`.gitignore` 忽略 `.agents/worktrees/`。
- 反思改为后台归档：`<history>` 块 token 合计达到 `reflectThresholdTokens` 时，尾部合计不超过阈值三分之一的块保留，至少保留 1 个，其余块在后台压缩为一个 `<archived-history>` 块。已有归档块不再二次归档，也不计入阈值。
- 归档块保留用户消息与已处理提问，相邻用户消息之间的模型内容各压成一句话，条目带 `key-word` 属性供 recall 检索；块 tip 提示用 recall 查看原文。
- 归档不阻塞会话，同一会话同时只运行一个；完成后由下一个有输入的 pre-step 提交，提交前校验被归档块仍连续在表层，否则丢弃结果。失败只记录 `compaction/end` 错误，块集合变化后重试。
- 被归档块中的 skill 按名称去重，提交时以 `skill-invocation` 消息注入，表层已有同名 skill 时不注入。
- `reflectThresholdTokens` 默认值改为 80000。
- `recall` 恒注册，删除 `recallEnabled` 配置；`query` 恒有效，`semanticRecallEnabled` 关闭时按字符串匹配，不区分大小写，按命中词数排序。
- 配置页删除原文召回开关，归档阈值文案同步更新。
- om 私有事件（警告、观察待定与失效标记、预压缩结果）不再借用 `feedback/record`，改用宿主 `appendPluginRecord` 写入 ignorable 的 plugin record：`plugin:dsh-plugin-om/warning`、`plugin:dsh-plugin-om/observe-pending`、`plugin:dsh-plugin-om/observe-invalidate`、`plugin:dsh-plugin-om/observe-summary`。含这些记录的会话日志不再作为用户反馈上传遥测，宿主读取路径保留并跳过记录，会话可正常加载。写入拆到 `src/om-event-append.ts`，`src/om-event.ts` 只读取，客户端 bundle 不引入宿主运行时。
- 不向后兼容：旧 `feedback/record` 中 `om:1:` 前缀信封不再识别，旧会话里未完成的观察待定标记与预压缩结果失效，警告行不再显示。
- DSH 最低版本升到 0.2.1-rc.2，`appendPluginRecord` 自 0.2.1-rc.1 起提供。
- README「已知风险」改写为 plugin record 的版本要求与不向后兼容。
- docs: 新增 compaction-tuning skill：OM 压缩质量的长流程评估优化。
