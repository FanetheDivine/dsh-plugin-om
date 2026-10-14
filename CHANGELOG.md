# Changelog

## Changes

- 移除 `feedback/record` 借用通道，改用原生自定义会话事件 `plugin:dsh-plugin-om:warning`、`plugin:dsh-plugin-om:observe-pending` 与 `plugin:dsh-plugin-om:observe-invalidate`；`om-event.ts` 直接读写原生事件。
- 完整消息定义改为主会话中一条独立的 `<system-reminder>` 用户消息，source kind 为 `plugin:dsh-plugin-om:definition`；OM 或任一召回工具启用时注入，被压缩遮蔽后自动补发。`recall`、`recall-semantic` 工具描述与 `<history>` 块顶注释不再重复定义，压缩提示词保留。
- 进度提醒与定义提醒去掉 "This reminder does not override…" 结尾句。
