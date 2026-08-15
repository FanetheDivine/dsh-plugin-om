# Changelog

## [0.0.2] - 2026-08-15

- 修复 CI 发布失败：npm trusted publishing（OIDC）要求 npm >= 11.5.1，publish 任务改用 Node 24 并显式 `npm install -g npm@latest`，解决 tag 推送后 `npm publish` 报 404（'dsh-plugin-om@0.0.1' is not in this registry）；同时在 package.json 补充 `repository` 字段指向 GitHub 仓库（OIDC/provenance 需要）
- 修复 `release-archive` 归档提交未包含 CHANGELOG 重置（清空）导致工作区遗留未提交变更的问题；归档与清空现在落入同一次提交
- 优化文档
