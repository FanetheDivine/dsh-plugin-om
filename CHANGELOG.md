# Changelog

## Changes

- 修复含 om 私有事件的会话无法加载：插件私有事件恢复借用宿主已知类型 `feedback/record` 持久化，`om:1:` 前缀 JSON 信封写入 text 字段。
