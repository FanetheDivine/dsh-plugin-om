# Changelog

## Unreleased

## Changes

- `@deepseek-ai/dsh-*` 依赖升级到 0.2.2-rc.1，内核包同步到 `cordis` 4.1.0、`cordis-plugin-loader` 1.1.0、`schemastery` 3.19.0。
- 压缩请求在 `LlmRequestPurposeMap` 声明 `compaction` purpose。
- 测试适配宿主新契约：native 工具执行器、批量工具调用、`agent/pre-step` 的 `modelSelection` 与 `fiber.effectiveConfig`。
- 删除误提交的 Serena 测试临时目录，测试启动时清理上次中断残留的目录。
