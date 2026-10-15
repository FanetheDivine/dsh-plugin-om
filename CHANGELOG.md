# Changelog

## Changes

- 新增 compaction-eval skill：对同一区间的压缩与重压缩变体做 subagent 盲评，按不可再生信息加权的保留率、尾部详略、无关信息压缩和耗时打分。
- agent-workflow 创建 worktree 前先 fetch 最新的 `origin/main`。
- 重压缩菜单支持多选模型和思考等级，一次提交按组合并行重压缩，并发上限由 `recompressConcurrency` 配置（默认 `2`）。
- 压缩提示词按后续用途分配摘要粒度，不再按位置越往后越细：未完成任务与当前状态保留细节，已完成子任务只留结果与决策，不可再生信息不论早晚都保留；反思额外要求合并已有摘要时不丢失不可再生信息。
