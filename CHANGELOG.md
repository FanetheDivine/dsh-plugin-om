# Changelog

## Unreleased

- feat: 注入压缩消息的 source.plugin 改为插件标识 `dsh-plugin-om`（替换消息的来源标记为插件名，compactionId 保留用于关联 summary；识别压缩日志仍兼容旧日志的宿主 checkpoint 标记 `compact`）
