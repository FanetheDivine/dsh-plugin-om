先阅读 [README.md](./README.md) 了解项目。

# 原则

- 简洁优先。只写必要信息，使用短句和列表，删除重复、铺垫、流水账和无关细节。
- 文档和注释只描述当前状态，不写新旧对比或变更过程。
- 与用户交互沟通时，优先调用 `ask_user_question`，不直接输出文本等待用户输入。

# 开发约定

- 文件变更后运行 `pnpm format && pnpm typecheck && pnpm lint`。
- 使用准确类型，避免 `unknown` 和 `any`。确需 `any` 时用 TSDoc 说明原因。
- 新增 `@deepseek-ai/dsh-*` 依赖时，将包名和版本加入 [pnpm-workspace.yaml](./pnpm-workspace.yaml) 的 `minimumReleaseAgeExclude`。
- `main` 分支的每个 commit 都需更新 [CHANGELOG.md](./CHANGELOG.md)。其他分支在 push 或 merge 前更新。
- 代码变更必须同步更新 `tests/`。测试应验证真实行为，不得只复述默认值、配置键、schema 结构或文案。
- 影响用户可见行为时同步更新 [README.md](./README.md)。
- README 只用短句概述安装、功能、配置、命令和文件地图，不展开细节，避免括号和破折号。详细实现由源码、类型和测试说明。
- 文件顶部简述职责和关键导出项。函数与常量使用简短注释说明用途。

# LSP 能力

本项目提供了 `pnpm serena` 命令，以使用 serena 的 LSP 能力。

**优先使用此能力，而不是 `grep` 或其他文本搜索能力。**

- `pnpm install` 会自动执行安装脚本。若被跳过，运行 `pnpm serena:setup`。
- 优先使用三个只读命令：
  - `pnpm serena definition <name_path>`：寻找定义。
  - `pnpm serena references <name_path>`：寻找引用。
  - `pnpm serena doc <name_path>`：查看签名和注释。
- 三个命令也支持 `--at <file_path>[:<line>]`，与 `name_path` 二选一。省略行号时只返回带 `line` 的文件符号候选；提供行号时只解析该行声明的符号。
- 删除 worktree 前在目标目录运行 `pnpm serena stop`，确认停止后离开目录再删除。
- 输入和输出中的行号均为 1 起始，输出路径使用 `/`。
- 使用 `pnpm serena --help` 或 `pnpm serena <命令> --help` 查看参数。
