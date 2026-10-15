# Changelog

## Changes

- 压缩卡片统计行改为“字符 压缩前 → 压缩后，耗时，provider/模型(思考等级)”，不再显示条数与 tokens；重压缩完成记录改为“重压缩完成 字符 原始 → 产物，耗时，provider/模型(思考等级)”。
- 同一会话允许多次换模型重压缩并行，不再提示“该会话已有重压缩进行中”。
- 新增进度提醒配置：`progressReminderEnabled` 控制是否注入，`progressReminderIdleEnabled` 控制长期无记录时是否重发，`progressReminderIdleSteps` 与 `progressReminderIdleToolCalls` 控制重发阈值，均支持热更新，默认值与此前行为一致
- 新增 `clear-branch` 技能：手动清空本地和远程除 main 之外的所有分支与 worktree。
- 新增 `release` 技能：手动执行 `pnpm run release`，等待 GitHub CI 完成与 npm 更新后汇报。
- 精简 `clear-branch` 与 `release` 技能说明，改为 `disable-model-invocation` 仅用户手动唤起。
