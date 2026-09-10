# Changelog

## Unreleased

- 开发工作流 skill 重命名为 agent-workflow 并迁移到 `.agents/skills/`：description 改为仓库内任何变更触发，checklist 要求每个功能点先变更测试再实现功能，验收要求本地 `pnpm check` 通过后再创建 PR，需求分析与 checklist 产物必须先完整输出再请用户确认，用户提出变更后必须重新输出完整文本
