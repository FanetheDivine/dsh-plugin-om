# Changelog

## Changes

- 进度提醒首句改为「在本会话中，你应当持续输出文本，…」，明确是本会话对 agent 的要求。
- 不再注入完整消息定义的 system-reminder（`plugin:dsh-plugin-om:definition`）；定义恢复到 `<history>` 块顶注释与 `recall`、`recall-semantic` 工具描述，压缩提示词保留。
- agent-workflow 技能：PR 合并后立即在主工作区 `git pull`，清理步骤不再包含拉取。
