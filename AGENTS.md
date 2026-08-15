阅读[README.md](./README.md)以了解此项目

# 开发约定

- 文件变更后调用 `pnpm format && pnpm lint` 进行格式化和语法检查
- **依赖同步**：在 `package.json` 中新增 `@deepseek-ai/dsh-*` 相关依赖后，必须同步将其（包名 + 版本）加入 [pnpm-workspace.yaml](./pnpm-workspace.yaml) 的 `minimumReleaseAgeExclude` 列表
- **CHANGELOG**：仅在 `main` 分支上，任何 commit 都必须为 [CHANGELOG.md](./CHANGELOG.md) 增加新条目；在非 `main` 分支（如 feat 分支）上，**不随 commit** 逐条添加 CHANGELOG，而是在分支提交完成后，按提交的 commit **分模块**整理添加 CHANGELOG 条目
- 任何**代码变更**都必须同步`tests/`的测试用例
- 任何影响用户可见行为的变化必须同步更新 [README.md](./README.md)
