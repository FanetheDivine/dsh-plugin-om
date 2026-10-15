---
name: release
description: 手动调用：git pull 后执行 pnpm run release，等待 GitHub CI 完成与 npm 更新，最后汇报结果。
whenToUse: 仅当用户明确要求发布时手动调用，不要自动触发
---

# release

发布新版本并跟踪发布链路直到 npm 可用。

## 1. 前置检查

- 当前分支为 main，工作区干净。
- [CHANGELOG.md](../../../CHANGELOG.md) 已有待发布条目（`## Changes` 下的列表）。
- 拉取最新代码：

```sh
git pull
```

## 2. 执行发布

```sh
pnpm run release
```

该命令依次执行：完整检查（typecheck + lint + test + build）、`npm version patch`、归档 CHANGELOG 并提交、push 分支与 tag。

- 记录产生的新版本号（package.json `version`）。
- 任一步骤失败则汇报失败原因，停止后续步骤。

## 3. 等待 GitHub CI

push tag 触发 CI，包含 check 与 publish（npm 发布）两个 job：

```sh
gh run watch   # 跟踪最新 run 直到结束
```

- check 或 publish 失败都视作发布失败：汇报失败的 job 与日志链接，停止后续步骤。
- 发布使用 npm trusted publishing（OIDC），无需本地凭证。

## 4. 等待 npm 更新

轮询 registry，直到版本号等于新版本：

```sh
npm view dsh-plugin-om version
```

## 5. 汇报

- 新版本号。
- CI run 链接与结果。
- npm 链接：https://www.npmjs.com/package/dsh-plugin-om
