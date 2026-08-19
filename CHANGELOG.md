# Changelog

## Unreleased

- feat: 注入压缩消息的 source.plugin 改为插件标识 `dsh-plugin-om`（替换消息的来源标记为插件名，compactionId 保留用于关联 summary；识别压缩日志仍兼容旧日志的宿主 checkpoint 标记 `compact`）
- 用户消息中合法的 `<system-reminder>` 块（完整开闭标签对且内容可被 XML 解析）整块原样保留、不转义；未压缩 token 统计排除该类块（宿主注入的工作区提醒不计入观察阈值触发量）
- 压缩时不包含‘下一步计划’