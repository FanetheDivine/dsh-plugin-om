# Changelog

## [0.0.37] - 2026-09-10

## Unreleased

- ask_user_question 提问条目格式调整：`<history>` 块与压缩视图中改为 `<ask-user-question index="…">` 元素，CDATA 内为 q:（问题文本，一个问题一行）与 a:（用户回答原文）行；旧版 `<askuserquestion>` 条目原样保留不转换，压缩提示词与块首格式说明注释同步更新
- 开发工作流 skill 重命名为 agent-workflow 并迁移到 `.agents/skills/`：description 改为仓库内任何变更触发，checklist 要求每个功能点先变更测试再实现功能，验收要求本地 `pnpm check` 通过后再创建 PR，需求分析与 checklist 产物必须先完整输出再请用户确认，用户提出变更后必须重新输出完整文本
