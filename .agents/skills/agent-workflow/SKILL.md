---
name: agent-workflow
description: 仓库内的任何变更，包括需求、缺陷、重构、测试、文档、配置等，都遵循此工作流。
---

# agent-workflow

按以下步骤严格串行

## 1. 创建 worktree

- fetch 最新的`origin/main`
- 基于`origin/main` ，在 `.dsh/worktrees/` 下创建 git worktree，分支名用 <feat,fix,etc.>/<kebab-case>。
- 以 --no-track 方式创建新分支
- 原工作区保持干净；后续的探索、确认、编码全部在 worktree 内进行。

```sh
git -C <项目根> worktree add ../<分支名> -b <分支名> origin/main --no-track
```

在worktree下载依赖

## 2. 需求分析

- 探索代码库与依赖：阅读文档、相关模块源码、测试用例，必要时用 web 搜索补充
- 与用户充分沟通，明确意图，对齐信息，消除歧义，做可行性分析，不把「不确定」「待确认」留到后续步骤
- 需求由三部分组成：背景，目标，预期实现
- 以**文本形式**输出完整需求，由用户确认；每次需求变更都输出完整需求文本而不是diff
- 用户确认后的完整需求文本，是后续的唯一真相

## 3. checklist

- 构造两级 checklist：
  - 一级 **模块**：相对独立的需求单位；
  - 二级 **功能点**：模块内可并行执行的最小单位，
- 遵循“模块按顺序严格串行”，“模块内功能点允许并行”的原则
- 测试先行，变更业务代码时，确保测试代码可以进行验证
- 以**文本形式**输出完整checklist，由用户确认实现细节；每次checklist变更都要输出完整文本而不是diff

## 4. 执行

- 每个功能点执行结束后，简单汇报情况
- 每个模块执行结束后，选择性地用subagent复核，并简单汇报情况
- 在一个模块执行结束后，commit

## 5. 验收

全部模块完成且自测通过（测试 / format / lint）后，在本地运行完整检查：

```sh
pnpm check   # typecheck + lint + test + build，必须全部通过
```

`pnpm check` 通过后才能 push 分支并创建 PR：

```sh
gh pr create --fill   # 创建 PR 并回传链接
```

确保pr的所有检查通过；如果与main冲突，将其merge到新分支并解决冲突；将输出链接让用户验收

- 用户验收通过后，以**压缩（squash）**方式将 PR 合并到主分支，并在主工作区拉取最新代码：

```sh
gh pr merge <分支名> --squash  # 压缩合并
git -C <项目根> pull  # 主分支拉取最新
```

- 若用户验收不通过，按情况回到`需求分析`或`checklist`

- 如果用户放弃此功能，关闭 PR：

```sh
gh pr close <分支名>  # 关闭 PR
```

## 5. 清理

无论第 4 步是合并 PR 还是放弃功能，都需要清理，因此独立为固定步骤：

- 删除 worktree、远程分支、本地分支：

```sh
git -C <项目根> push origin --delete <分支名>  # 删除远程分支
git -C <项目根> worktree remove ../<分支名> --force  # 移除 worktree（先于删除本地分支）
git -C <项目根> branch -D <分支名>  # 删除本地分支
```
