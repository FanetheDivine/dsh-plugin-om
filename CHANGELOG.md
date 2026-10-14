# Changelog

## Changes

- 调整完整消息定义提醒的注入时机：未启用 recall 时仅在表层已有压缩历史块后注入，避免未启用 recall 且未发生压缩时注入无效定义。
- 更新开发约定：文件变更后增加 `pnpm typecheck` 检查要求。

