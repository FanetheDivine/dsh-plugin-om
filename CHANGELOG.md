# Changelog

## Unreleased

- 压缩会话记录携带压缩统计：子会话末尾追加统计消息（起止时间、总耗时、逐轮请求耗时与各类 token usage 及合计），主会话 `compaction/summary` 记录 usage 与压缩计时，失败路径 `compaction/end` 记录总耗时
- 压缩卡片不再展示请求轮数（轮数明细归诊断子会话），`compaction/summary` 不再写入 `attemptCount`
- README 为 `compressSkipReasoning` 配置项补充说明：关闭会严重降低压缩质量，仅作为可选开关存在
- dsh-plugin-coding skill 将 worktree 与分支清理独立为第 5 步：无论 PR 合并还是放弃均需执行
- `<history>` 块中未压缩的 skill 加载条目以 `<skill name="…" index="…">` 元素呈现，元素内文为其工具返回内容，压缩后变为常规 assistant 摘要条目
