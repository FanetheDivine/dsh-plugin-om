# Changelog

## Unreleased

### Changed

- 反思压缩把全部 `<history>` 块内文拼合为单个块送入摘要调用，替代多个块直接拼接；拼合时剥离各块块首格式说明注释，正文条目内的同名串保留
- 按新文档规范优化 README：一句话功能概况加提纲式分节，去括号与破折号，文件地图补齐 `src/json-schema.ts`
- AGENTS.md 文档规范明确 README 需一句话描述功能概况，不使用括号和破折号
- 成本计算器把每轮新增 tokens 拆分为 thinking 与 tool result 两个参数：thinking 只计补全价，tool result 只写入缓存并驱动上下文增长
- 成本计算器计入摘要调用自身的 thinking：按摘要输入 tokens 的 50% 折算并按补全价计费，不写入缓存；成本表假设区同步展示该口径
- 摘要压缩提示词要求 `<assistant>` 聚合块内描述行为逻辑并强调关键的结论、产出与任务，涉及文件保留完整路径，不再要求合并简写路径
