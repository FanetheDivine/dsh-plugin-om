# Changelog

## Unreleased

- README 为 `compressSkipReasoning` 配置项补充说明：关闭会严重降低压缩质量，仅作为可选开关存在
- dsh-plugin-coding skill 将 worktree 与分支清理独立为第 5 步：无论 PR 合并还是放弃均需执行
- `<history>` 块中未压缩的 skill 加载条目以 `<skill_content name="…" index="…">` 元素呈现，内含 `<skill_resources>` 与 `<skill_instructions>` 两段，压缩后变为常规 assistant 摘要条目
- `<history>` 块条目正文一律以 CDATA 包裹，CDATA 内为逐字原样内容；compressHistory 的 content 参数要求纯文本，含 CDATA 包裹时报错
