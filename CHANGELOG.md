# Changelog

## Unreleased

### Changed

- 反思压缩把全部 `<history>` 块内文拼合为单个块送入摘要调用，替代多个块直接拼接；拼合时剥离各块块首格式说明注释，正文条目内的同名串保留
- 按新文档规范优化 README：一句话功能概况加提纲式分节，去括号与破折号，文件地图补齐 `src/json-schema.ts`
- AGENTS.md 文档规范明确 README 需一句话描述功能概况，不使用括号和破折号
