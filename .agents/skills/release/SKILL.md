---
name: release
description: 发布新版本至npm
disable-model-invocation: true
---

# release

发布新版本并跟踪发布链路。

- git pull & pnpm i
- pnpm run release
- gh run watch 直到ci完成
- npm view dsh-plugin-om version 确保npm上有新版本
- 汇报情况
