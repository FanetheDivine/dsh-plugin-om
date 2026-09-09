# Changelog

## [0.0.36] - 2026-09-09

## Unreleased

- 压缩视图与 `<history>` 块中的 toolcall 条目改为结构化形态 `<assistant type="toolcall" tool-name="…" callId="…" index="…">`，内含 `<tool-args>`（调用参数 JSON，仅一层转义）与 `<tool-result>` 两个 CDATA 子元素，与 recall 工具输出同构；getHistory 输出、压缩提示词与块首格式说明注释同步更新，反思轮对旧格式纯文本条目保持解析兼容
