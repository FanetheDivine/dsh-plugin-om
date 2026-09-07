# Changelog

## Unreleased

- README 为 `compressSkipReasoning` 配置项补充说明：关闭会严重降低压缩质量，仅作为可选开关存在
- dsh-plugin-coding skill 将 worktree 与分支清理独立为第 5 步：无论 PR 合并还是放弃均需执行
- `<history>` 块中未压缩的 skill 加载条目以 `<skill name="…" index="…">` 元素呈现，元素内文为其工具返回内容，压缩后变为常规 assistant 摘要条目
