---
name: clear-branch
description: 手动调用：清空本地和远程除 main 之外的所有分支与 worktree。
whenToUse: 仅当用户明确要求清空分支时手动调用，不要自动触发
---

# clear-branch

清空除 main 之外的所有本地分支、远程分支和 worktree。操作不可逆，按以下顺序执行。

## 1. 前置检查

- 当前分支必须是 main。
- 工作区必须干净，有未提交变更时先询问用户处理方式。

## 2. 列出待删除项并确认

先完整列出将被删除的 worktree 和分支，请用户确认后再执行删除：

```sh
git worktree list   # 主 worktree 之外的全部删除
git branch          # main 之外的全部删除
git branch -r       # origin/main 与 origin/HEAD 之外的全部删除
```

## 3. 删除

先删 worktree，再删远程分支，最后删本地分支：

```sh
git worktree remove <路径> --force    # 逐个移除非主 worktree
git push origin --delete <分支名>     # 逐个删除远程分支
git branch -D <分支名>                # 逐个删除本地分支
git fetch --prune                     # 清理残留远程引用
```

主 worktree（仓库根目录）和 main 分支不删除。
