# Changelog

## Unreleased

### Fixed

- 观察判定（`observePass`）的净压力在「上下文压力 − 已压缩 `<history>` 块」基础上额外扣除系统提示词 token 估算（按 agent 作用域组装渲染系统提示词后按长度/4 计），避免净压力高估导致观察偏早触发；宿主未提供 `systemPrompt` 服务或组装/渲染失败时按 0 计并输出 warn 日志
