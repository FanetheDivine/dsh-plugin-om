# Changelog

## Unreleased

## Changes

- fix: `/om-compaction-eval` 在斜杠菜单中点击无响应。菜单行的 mousedown 在事件派发过程中同步打开面板，面板挂载后注册的 document mousedown 外点关闭监听会收到仍在冒泡的同一次事件，导致面板刚打开即被关闭。现在外点关闭忽略 timeStamp 早于挂载时刻的事件。
- fix: `compaction-eval-command.test.ts` 中注册命令的用例显式放宽超时到 30s。该用例在用例体内首次导入 `src/index.ts`，全量并行时导入耗时可达约 7s，超出默认 5s 而随机失败。