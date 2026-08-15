# Changelog

## Unreleased

- feat: 在消息记录/轨迹中添加OM结果——压缩结果写入宿主 `compaction/*` 生命周期事件（`compaction/start` → `compaction/summary` → 替换 `<om-history>` 消息 → `compaction/end`），替换消息改用宿主 checkpoint 标记（`plugin: 'compact'` + `compactionId`），聊天视图显示压缩卡片、轨迹视图显示压缩请求；`compaction/summary` 承担影子价格认领，移除独立的 `compaction/prune` 事件
