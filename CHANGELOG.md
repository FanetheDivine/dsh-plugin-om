# Changelog

## Unreleased

- docs: 同步README（工作原理 / 注意 / 调用链文件地图）与 CHANGELOG；移除已废弃的 CLAIM_EVENT 常量
- feat: 将OM会话（摘要fork）的token归入主会话——fork 子会话运行结束后提取其 token usage（`assistant/message`/`assistant/chunk` usage，按 turn/step 去重累加，跳过继承的父会话 seed 前缀），写入主会话 `compaction/summary.usage`，轨迹视图可见；无 usage 时省略字段
- feat: 在消息记录/轨迹中添加OM结果——压缩结果写入宿主 `compaction/*` 生命周期事件（`compaction/start` → `compaction/summary` → 替换 `<om-history>` 消息 → `compaction/end`），替换消息改用宿主 checkpoint 标记（`plugin: 'compact'` + `compactionId`），聊天视图显示压缩卡片、轨迹视图显示压缩请求；`compaction/summary` 承担影子价格认领，移除独立的 `compaction/prune` 事件
- 增加coding skill
- 调整AGENTS.md 要求同步pnpm-workspace.yaml；要求非main分支 提交简洁的Changelog
