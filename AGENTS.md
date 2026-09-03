阅读[README.md](./README.md)以了解此项目

# 开发约定

- 文件变更后调用 `pnpm format && pnpm lint` 进行格式化和语法检查
- **依赖同步**：在 `package.json` 中新增 `@deepseek-ai/dsh-*` 相关依赖后，必须同步将其（包名 + 版本）加入 [pnpm-workspace.yaml](./pnpm-workspace.yaml) 的 `minimumReleaseAgeExclude` 列表
- **CHANGELOG**：仅在 `main` 分支上，任何 commit 都必须为 [CHANGELOG.md](./CHANGELOG.md) 增加新条目；在非 `main` 分支，push或merge时添加 CHANGELOG 条目
- 任何**代码变更**都必须同步`tests/`的测试用例
- 任何影响用户可见行为的变化必须同步更新 [README.md](./README.md)
- 文档和注释应当描述"现状"，而不是"变化"。陈述静态情况即可，不需要和之前对比

# 文档与注释规范

- 不写"过去 xxx""改为 xxx"这类对比性描述，专注于静态描述现状
- README 提纲挈领：只描述功能概况（安装、功能、配置、命令、文件地图），不做详细解释
- 每个文件顶部的注释简要解释该文件的功能，并说明关键导出项
- 每个函数/常量有注释，简要解释其功能
