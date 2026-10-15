# Changelog

## Changes

- 新增 `clear-branch` 技能：手动清空本地和远程除 main 之外的所有分支与 worktree。
- 新增 `release` 技能：手动执行 `pnpm run release`，等待 GitHub CI 完成与 npm 更新后汇报。
- 精简 `clear-branch` 与 `release` 技能说明，改为 `disable-model-invocation` 仅用户手动唤起。
