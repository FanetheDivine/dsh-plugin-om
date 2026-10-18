---
name: compaction-tuning
description: 长流程评估优化 OM 压缩质量
disable-model-invocation: false
---

# compaction-tuning

长流程评估优化 OM 压缩质量：诊断压缩产物问题、设计改进点、盲测挑选、回归验证。全程数小时，手动触发后建议用户不要等待结果，用后台任务执行。无人值守触发时全自动运行，不向用户提问，决策与异常写入报告。

评分维度、盲评纪律、facts 与 judge 提示词沿用 [compaction-eval](../compaction-eval/SKILL.md)，脚本目录 `S=.agents/skills/compaction-eval/scripts`。

## 约定

- 产物根为 `/tmp/om-compaction-eval/tuning-<YYYYMMDD>/`，全部文件写在这里，不写主工作区。
- 代码实验只在 `.dsh/worktrees/` 内的 worktree 进行；主工作区只 fetch，不改动。
- 重压缩的模型与思考等级和所选样本的压缩日志保持一致。
- 重压缩并发不超过 3，评审 subagent 并发不超过 6。
- 不创建 PR、不 push；流程结束后 worktree 与分支保留，供人工复核。

## 步骤

### 1. 选样本

1. `git fetch origin`。
2. 扫描 `~/.dsh/sessions` 下 `om-compaction-log-` 开头的子会话，只保留成功且非重压缩的日志。
3. 一致性判定，只保留同时满足两条的日志：
   - `system/message` 与 origin/main 代码生成的某个合法 system 变体逐字一致。变体指 `buildCompressionPrompt` 的两个 skipReasoning 取值，与可选的反思段、提问段追加后的全部组合；在 origin/main 的干净 worktree 内运行导出函数生成变体集合。
   - 日志创建时间晚于工具基准时间：用 `git log` 找最近一次改动压缩工具 schema（`src/compress-tools.ts`）的提交，再用 `git tag --contains` 取包含该提交的最早版本 tag，以该 tag 的提交时间为准。
4. 按单条日志 tokens_in（inputTokens+cacheRead+cacheWrite）排序，取前二为 a、b，两者压缩区间不得重叠。
5. 只有 1 条时只跑 a，报告注明缺 b；0 条时写无样本报告后结束。

### 2. 诊断 a

1. `prepare.ts` 在 `<产物根>/diag-a/` 建 a 区间的评估目录，候选只有原始压缩。
2. 生成事实清单，2 名评审盲评原始产物，`aggregate.ts` 汇总。
3. 主分析阅读评分与产物，归纳问题清单：丢失事实、无依据断言、无关信息、结构与冗余。
4. OM 会话之外的观察单独记录，例如主会话模型没有按要求输出中间结论导致素材质量差；只写进报告，不作为改进点依据。

### 3. 改进点

- 最多 3 个，可以是 0 个；为 0 时报告注明并跳过后续步骤。
- 范围是影响 OM 压缩会话的插件代码：系统提示词、工具 schema、压缩循环行为。
- 每个改进点一个 worktree 与分支 `tuning/<YYYYMMDD>-opt<N>`，基于 origin/main 以 `--no-track` 创建，附单元测试；`pnpm install` 后 format、typecheck、lint、test 全部通过。

### 4. 盲测 a 区间

1. 重压缩：基线 3 次，每个改进点 3 次。基线在 origin/main 的干净 worktree 内对 a 重压缩。
2. `prepare.ts` 建正式评估目录 `<产物根>/eval-a/`，候选含 a 的原始压缩、全部基线与全部改进点运行；复用诊断的事实清单，前提是两目录 `source.xml` 逐字节一致。
3. 每候选 2 名评审盲评，`aggregate.ts` 汇总。
4. 最优为综合分最高且不低于基线重压缩均值的改进点；全部低于基线时判定无有效改进，跳过后续步骤并在报告注明。

### 5. 回归 b 区间

1. `prepare.ts` 建 `<产物根>/eval-b/`，生成事实清单。
2. 候选：b 的原始压缩 1 份，最优改进点重压缩 3 次。
3. 每候选 2 名评审。判定：综合分与保留分均值都不低于原始压缩，或差距在 1 个标准差内；临界时补采 2 次再判。
4. 回退则不采纳，报告注明，worktree 与评估目录保留待人工复核。

### 6. 报告

`report.md` 写入产物根，内容包括：

- 样本：会话、区间、模型与等级、tokens、一致性判定结果。
- 问题清单与 OM 会话之外的观察。
- 改进点说明、worktree 与分支路径。
- 盲测与回归的评分表、结论、采纳建议。

在会话内输出报告摘要。
