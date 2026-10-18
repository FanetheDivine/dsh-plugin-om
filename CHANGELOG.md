# Changelog

## Unreleased

## Changes

- om 私有事件（警告、观察待定与失效标记、预压缩结果）不再借用 `feedback/record`，改用宿主 `appendPluginRecord` 写入 ignorable 的 plugin record：`plugin:dsh-plugin-om/warning`、`plugin:dsh-plugin-om/observe-pending`、`plugin:dsh-plugin-om/observe-invalidate`、`plugin:dsh-plugin-om/observe-summary`。含这些记录的会话日志不再作为用户反馈上传遥测，宿主读取路径保留并跳过记录，会话可正常加载。写入拆到 `src/om-event-append.ts`，`src/om-event.ts` 只读取，客户端 bundle 不引入宿主运行时。
- 不向后兼容：旧 `feedback/record` 中 `om:1:` 前缀信封不再识别，旧会话里未完成的观察待定标记与预压缩结果失效，警告行不再显示。
- DSH 最低版本升到 0.2.1-rc.2，`appendPluginRecord` 自 0.2.1-rc.1 起提供。
- README「已知风险」改写为 plugin record 的版本要求与不向后兼容。
- docs: 新增 compaction-tuning skill：OM 压缩质量的长流程评估优化。
