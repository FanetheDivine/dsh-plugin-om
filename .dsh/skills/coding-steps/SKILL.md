---
name: coding-steps
description: 需求，缺陷，worktree，dsh-plugin-om
whenToUse: 需求，缺陷，worktree，dsh-plugin-om
---

# coding-steps

适用于 `dsh-plugin-om` 项目的工作流

接到需求或缺陷任务后，按以下步骤执行，不要跳过、合并或随意更改顺序。

## 1. 创建 worktree

- 在**项目文件夹的上级（平行）位置**创建 git worktree，分支名用 kebab-case 概括需求/缺陷，基于最新基线（如 `origin/main`）。
- 以 --no-track 方式创建新分支
- 原工作区保持干净；后续的探索、确认、编码全部在 worktree 内进行。

```sh
git -C <项目根> worktree add ../<分支名> -b <分支名> origin/main --no-track
```

在worktree下载依赖

## 2. 需求分析

- **向用户确认每个细节**：行为预期、边界条件、影响范围、验收标准等
- 探索代码库与依赖：阅读文档、相关模块源码、测试用例，必要时用 web 搜索补充
- 明确用户准确意图，明确第三方库和代码的能力范围，不把「不确定」「待确认」留到后续步骤
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

- **用户中断/放弃**：删除分支。
- **两种结局都必须清理 worktree**：

```sh
git -C <项目根> worktree remove ../<分支名> --force
git -C <项目根> branch -D <分支名>
```
