# Changelog

## [0.0.9] - 2026-08-16

- fix: 修复 lint 提示（useTemplate：字符串拼接改模板字面量）；同步观察/反思提示词测试断言（「当前消息仅作为指令，**不得**进入日志」「目的、行为、结果」）
- chore: release 命令前置 pnpm check（发布前自动跑 typecheck+lint+test+build）
