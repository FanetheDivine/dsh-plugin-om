---
name: clear-branch
description: 清空本地和远程除 main 之外的所有分支与 worktree。
disable-model-invocation: true
---

# clear-branch

强制删除所有 worktree，强制删除 main 之外的所有本地、远程分支。

- 删除每个目标 worktree 前，在该目录运行 `pnpm serena stop` 并确认停止。Windows 上语言服务器会占用项目目录。
- 停止失败时先解决问题，不继续删除。
- 离开目标 worktree，切换到保留的主工作区后再删除。

这个skill只能用户唤起，因此执行此操作无需询问。
