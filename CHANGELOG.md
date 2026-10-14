# Changelog

## Changes

- 优化 WebUI 消息列表卡片在移动端与较窄视口下的水平滚动体验，折叠行摘要与展开体支持左右滑动与触摸滚动。
- 重构插件配置面板布尔字段布局，移除「继承默认」冗余文案，使用规范的覆盖徽章与恢复默认操作。
- 完整消息定义改为主会话中一条独立的 `<system-reminder>` 用户消息，source kind 为 `plugin:dsh-plugin-om:definition`；OM 或任一召回工具启用时注入，被压缩遮蔽后自动补发。`recall`、`recall-semantic` 工具描述与 `<history>` 块顶注释不再重复定义，压缩提示词保留。
- 进度提醒与定义提醒去掉 "This reminder does not override…" 结尾句。
