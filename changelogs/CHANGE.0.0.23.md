# Changelog

## [0.0.23] - 2026-09-03

## Unreleased

### Added

- 压缩摘要尝试全部耗尽后拒绝当前 step，当前 turn 以 blocked 结束、不再继续 AI 会话（signal 中止除外）：最后一次尝试的实际报错写入日志与 `compaction/end` error，浏览器客户端渲染可展开的「上下文压缩失败」错误行（用户主动中止维持静默撤回）
- 每次压缩尝试的结果/报错始终写入日志（成功 info / 失败 warn，不受 `debug` 影响）；失败原因为说明具体问题的文案（如缺少 `<history>` 块、条目 index 不连续），不再输出解析器原始报错；xmldom 非致命解析消息不再走 console，模型下载日志只走日志门面

### Fixed

- vitest 排除 `.dsh/` 目录（`configDefaults.exclude` 基础上追加），不再收集 `.dsh/worktrees/` 内 worktree 副本中的重复测试；`.gitignore` 忽略 `.dsh/worktrees/`
- 观察判定（`observePass`）的净压力在「上下文压力 − 已压缩 `<history>` 块」基础上额外扣除系统提示词 token 估算（按 agent 作用域组装渲染系统提示词后按长度/4 计），避免净压力高估导致观察偏早触发；宿主未提供 `systemPrompt` 服务或组装/渲染失败时按 0 计并输出 warn 日志
- 观察判定（`observePass`）的净压力额外扣除工具定义 token 估算（按会话请求头 tools 的 JSON 序列化长度/4 计），避免固定的工具 schema 撑大净压力导致观察偏早触发；会话请求头缺失或无 tools 时按 0 计

### Changed

- 观察阈值（`observeThresholdTokens`）默认改为 45000 tokens、反思阈值（`reflectThresholdTokens`）默认改为 120000 tokens
- 摘要生成上限（`compressMaxTokens`）默认改为不设置——默认不向摘要请求发送 `maxTokens`，由模型适配器默认值决定；显式配置整数时按原样生效，载荷与日志中该字段省略/显示为未设置
- `.dsh/skills/dsh-plugin-coding/SKILL.md`：验收通过并创建 PR 后，待 PR 创建成功且所有检查通过，以压缩（squash）方式将 PR 合并到 `main`，随后删除远程分支与本地分支，并在主工作区执行 `git pull`
