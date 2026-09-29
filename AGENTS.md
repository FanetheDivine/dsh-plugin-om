先阅读 [README.md](./README.md) 了解项目。

# 原则

- 简洁优先。只写必要信息，使用短句和列表，删除重复、铺垫、流水账和无关细节。
- 文档和注释只描述当前状态，不写新旧对比或变更过程。

# 开发约定

- 文件变更后运行 `pnpm format && pnpm lint`。
- 使用准确类型，避免 `unknown` 和 `any`。确需 `any` 时用 TSDoc 说明原因。
- 新增 `@deepseek-ai/dsh-*` 依赖时，将包名和版本加入 [pnpm-workspace.yaml](./pnpm-workspace.yaml) 的 `minimumReleaseAgeExclude`。
- `main` 分支的每个 commit 都需更新 [CHANGELOG.md](./CHANGELOG.md)。其他分支在 push 或 merge 前更新。
- 代码变更必须同步更新 `tests/`。测试应验证真实行为，不得只复述默认值、配置键、schema 结构或文案。
- 影响用户可见行为时同步更新 [README.md](./README.md)。
- README 只用短句概述安装、功能、配置、命令和文件地图，不展开细节，避免括号和破折号。详细实现由源码、类型和测试说明。
- 文件顶部简述职责和关键导出项。函数与常量使用简短注释说明用途。
