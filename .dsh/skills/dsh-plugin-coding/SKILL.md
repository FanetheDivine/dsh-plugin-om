---
name: dsh-plugin-coding
description: 需求，缺陷，worktree，dsh，plugin
whenToUse: 需求，缺陷，worktree，dsh，plugin
---

# dsh-plugin-coding

接到需求或缺陷任务后，按以下步骤执行，不要跳过、合并或随意更改顺序。

## 1. 创建 worktree

- 基于`origin/main` ，在 `.dsh/worktrees/` 下创建 git worktree，分支名用 <feat,fix,etc.>/<kebab-case>。
- 以 --no-track 方式创建新分支
- 原工作区保持干净；后续的探索、确认、编码全部在 worktree 内进行。

```sh
git -C <项目根> worktree add ../<分支名> -b <分支名> origin/main --no-track
```

在worktree下载依赖

## 2. 需求分析

- **向用户确认每个细节**：行为预期、边界条件、影响范围、验收标准等
- 探索代码库与依赖：阅读文档、相关模块源码、测试用例，必要时用 web 搜索补充
- 明确用户准确意图，做可行性分析，不把「不确定」「待确认」留到后续步骤
- 将确认后的完整需求整理成清晰表述，**经用户确认后**写入 goal（create_goal），后续以此为准。

## 3. 执行

- 构造两级 checklist：
  - 一级 **模块**：提交的最小单位；
  - 二级 **功能点**：可并行执行的最小单位。
- checklist 先交给用户**二次确认**。
- 确认后：
  - 每个**模块**写为一个 task（todo_write），一个模块对应一个 commit；
  - 模块内的**功能点可以并行**执行（可交给子代理/subagent 并行完成）。

## 4. 验收

- 全部模块完成且自测通过（测试 / format / lint）后，请用户**验收**。
- **验收通过**：push 分支到远程并创建 PR，把 PR 链接交给用户：

```sh
git push -u origin <分支名>
gh pr create --fill   # 或用其他方式创建 PR 并回传链接
```

- PR 创建成功且**所有检查通过**后，以**压缩（squash）**方式将 PR 合并到主分支，删除远程分支与本地分支，并在主工作区执行 `git pull`：

```sh
gh pr merge <分支名> --squash --delete-branch  # 压缩合并，并删除远程分支
git -C <项目根> worktree remove ../<分支名> --force  # 移除 worktree（先于删除本地分支）
git -C <项目根> branch -D <分支名>  # 删除本地分支
git -C <项目根> pull  # 主分支拉取最新
```

- **用户中断/放弃**：删除分支并移除 worktree：

```sh
git -C <项目根> worktree remove ../<分支名> --force
git -C <项目根> branch -D <分支名>
```
