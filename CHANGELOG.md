# Changelog

## Unreleased

## Changes

- `@deepseek-ai/dsh-*` 依赖升级到 0.2.2-rc.1，内核包同步到 `cordis` 4.1.0、`cordis-plugin-loader` 1.1.0、`schemastery` 3.19.0。
- 适配宿主新契约：向 `LlmRequestPurposeMap` 声明 `compaction` purpose；测试挂载 native 工具执行器，改用批量工具调用、`agent/pre-step` 的 `modelSelection` 与 `fiber.effectiveConfig`，导出测试按路径选择会话日志路由。