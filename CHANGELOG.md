# Changelog

## Changes

- 服务端只强依赖 `llm` 和 `tokenMeter`：`tools` 缺失时不注册 `recall`，`sessions` 缺失时跳过压缩会话记录落盘，`commands` 缺失时不注册重压缩命令，压缩与日志替换照常运行。
- 手动加载的 skill（`skill-invocation` 系统消息）重新计入完整消息：占 index，recall 输出 `<skill_content>`，压缩视图与工具加载的 skill 一致保留原文；其余系统消息仍不占 index。
- compaction-eval 的 SKILL.md 只保留主流程，评分维度只在一处说明，规则与提示词不再重复判定和计分；脚本直接用 `node` 运行。
- compaction-eval 可自行生成变体：`view.ts` 列出会话已有压缩，按压缩 id 或完整消息区间复现压缩输入视图；`compress.ts` 读 DSH profile 的模型与凭据直连模型跑压缩，产出重压缩日志且不改原会话；`prepare.ts --variants` 并入这些日志。重复次数与模型、思考等级组合由调用方组合脚本实现。
- compaction-eval 的 SKILL.md、规则与评审提示词按输入、任务、输出重新组织，语言更简洁。
- 新增 compaction-eval skill：读取本地会话或 DSH 导出的会话日志 zip，对同一区间的压缩与重压缩变体做 subagent 盲评，按关键信息保留 70%、无关信息压缩 20%、精简度 5%、模型耗时 5% 打分，保留率按不可再生信息加权；每变体两名评审取均值，同模型多变体输出综合分均值与标准差。
- agent-workflow 创建 worktree 前先 fetch 最新的 `origin/main`。
- 重压缩菜单支持多选模型和思考等级，一次提交按组合并行重压缩，并发上限由 `recompressConcurrency` 配置（默认 `2`）。
- 压缩提示词按后续用途分配摘要粒度，不再按位置越往后越细：未完成任务与当前状态保留细节，已完成子任务只留结果与决策，不可再生信息不论早晚都保留；反思额外要求合并已有摘要时不丢失不可再生信息。
