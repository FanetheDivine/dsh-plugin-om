# Changelog

## [0.0.16] - 2026-08-20

## Unreleased

- feat: 完整消息纳入系统消息——user_message 中 `source.kind` 为 `user` 的部分为用户消息，其余部分（宿主注入的上下文等）为系统消息，均参与完整消息 index，用于压缩与 recall
- 系统消息在压缩日志中渲染为 `<sys type="KIND" index="N"></sys>` 空块（内容不进入压缩输入）；压缩结果必须逐条保留该空块（type 与 index 不变）
- 删除 `<system-reminder>` 块的特殊转义与 token 扣除逻辑：用户消息文本统一按普通文本转义；未压缩消息 token 统计排除系统消息
- 本插件自产的压缩日志消息（source.kind 为 `plugin` 且 plugin 为 `dsh-plugin-om`，兼容旧 checkpoint 标记 `compact`）不占完整消息 index
