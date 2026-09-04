# Changelog

## [0.0.24] - 2026-09-04

- dsh-plugin-coding skill 第四步验收流程补充完整命令：验收通过后的 squash 合并块补回移除 worktree、删除本地分支、主分支 `git pull`，新增用户放弃功能时关闭 PR 并清理 worktree 与分支的命令块

- 压缩辅助估算容错降级：systemPrompt 服务改经 `ctx.get` 容错读取（服务未挂载时属性访问抛错导致压缩被阻塞），挂载失败类问题（systemPrompt/tokenMeter 服务异常）始终 console.warn 到宿主进程外部并向会话写入 log-only `om/warning` 事件（同会话同一问题至多一条），系统提示词/工具定义/tokenMeter 估算失败按 0 计、tokenMeter 压力读取失败跳过观察，均不阻塞压缩
- 客户端把 `om/warning` 事件渲染为可展开的「上下文压缩功能降级」警告行（zh/en 文案）
- 新增真实 cordis + dsh 服务堆叠（SessionStore/LlmRuntime/TokenMeter/SystemPrompt/ToolRuntime + mock LLM adapter）的整条压缩链路集成测试

- recall / recall-semantic 工具描述与参数 schema 描述精简，共享的「完整消息」定义缩短，降低系统提示词与 history 块的固定 token 占用
