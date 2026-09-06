# Changelog

## Unreleased

### Changed

- coding skill 验收合并时以 `git push origin --delete` 显式删除远程分支，不再依赖 `gh pr merge --delete-branch`
- 诊断子会话 label 改为 `OM会话-<阶段>`（观察/反思/压缩），有重试时追加 `-重试N`（N = 尝试序号 - 1）
- 诊断子会话落盘内容扩展为模型完整输出：在文本输出之外新增 thinking（reasoning）与工具调用内容块，按 reasoning → text → tool-call 顺序原样还原
- 成本计算器新增「压缩 thinking」开关，默认关闭：开启后观察压缩把被压缩 assistant 消息的 thinking 随消息一并送入 OM 摘要，thinking 仍不计入主会话上下文
- 成本计算器「系统提示词」默认占用 10000 tokens
