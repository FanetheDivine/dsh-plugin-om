# Changelog

## [0.0.42] - 2026-09-28

## Unreleased

- 适配 dsh 0.1.7-rc.2：全部 `@deepseek-ai/dsh-*` 依赖升级至 0.1.7-rc.2、`@deepseek-ai/cordis` 升级至 ^4.0.4，移除零引用的 `dsh-code-runtime`；工具结果按 0.1.7 一等 tool 角色消息处理（压缩会话记录子会话以 `tool/result` 事件落盘，压缩循环组装器不再传 `kind`），`isPluginOwnedSource` 增认宿主压缩 checkpoint 源 `compact-checkpoint`，客户端卡片图标改用 `IconBrowseOutlineRegular`；压缩链路覆盖 developer/message 共存场景
