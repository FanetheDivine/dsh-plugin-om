# Changelog

## [0.0.35] - 2026-09-09

## Unreleased

- fix: 适配 dsh 0.1.2-rc.1，修复 Web 客户端因 `conversationEvents` 服务移除而卡在 `pending (waiting for service: conversationEvents)` 无法激活的问题。客户端改用 `uiConversation` 服务（`ctx.uiConversation.events.register`），会话定义类型改从 `@deepseek-ai/dsh-client-ui-conversation/client`（Chat 节点契约在 `@deepseek-ai/dsh-client-ui-chat/client`），`@deepseek-ai/dsh-client-runtime` 依赖移除
- fix: 服务端迁移 dsh 0.1.2-rc.1 的 Session API（`session.events` 改用 `session.snapshotEvents()`，compaction 载荷与 surfaceOp 的 seq 字段使用品牌类型 `SessionSeq`），devDependencies 全量升级到 `^0.1.2-rc.1` 并同步 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`
- test: 集成测试堆叠补挂 `SessionProjectionRegistry`（0.1.2 起 TokenMeter 依赖 sessionProjections），断言改用 `snapshotEvents()` 并引用 `SUBAGENT_DESCRIPTOR_VERSION` 常量
