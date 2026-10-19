# Changelog

## Unreleased

## Changes

- fix: `compaction-eval-command.test.ts` 中注册命令的用例显式放宽超时到 30s。该用例在用例体内首次导入 `src/index.ts`，全量并行时导入耗时可达约 7s，超出默认 5s 而随机失败。