# Changelog

## Changes

- 合并 `recall` 与 `recall-semantic` 为单一 `recall` 工具：语义检索改为 `recall` 的增强能力，带 `query` 参数时按含义检索，不带时按 index 区间回看；`recall-semantic` 工具移除。`semanticRecallEnabled` 依赖 `recallEnabled`，`recallEnabled` 关闭时语义增强一并失效；设置页勾选「语义增强」会一并勾选「原文召回」，取消「原文召回」会一并取消「语义增强」。
- 优化 WebUI 消息列表卡片在移动端与较窄视口下的水平滚动体验，折叠行摘要与展开体支持左右滑动与触摸滚动。
- 重构插件配置面板布尔字段布局，移除「继承默认」冗余文案，使用规范的覆盖徽章与恢复默认操作。
- 移除 `feedback/record` 借用通道，改用原生自定义会话事件 `plugin:dsh-plugin-om:warning`、`plugin:dsh-plugin-om:observe-pending` 与 `plugin:dsh-plugin-om:observe-invalidate`；`om-event.ts` 直接读写原生事件。
- 完整消息定义改为主会话中一条独立的 `<system-reminder>` 用户消息，source kind 为 `plugin:dsh-plugin-om:definition`；OM 或任一召回工具启用时注入，被压缩遮蔽后自动补发。`recall`、`recall-semantic` 工具描述与 `<history>` 块顶注释不再重复定义，压缩提示词保留。
- 进度提醒与定义提醒去掉 "This reminder does not override…" 结尾句。
