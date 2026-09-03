# Changelog

## Unreleased

### Added

- 压缩摘要尝试全部耗尽后拒绝当前 step，当前 turn 以 blocked 结束、不再继续 AI 会话（signal 中止除外）：最后一次尝试的实际报错写入日志与 `compaction/end` error，浏览器客户端渲染可展开的「上下文压缩失败」错误行（用户主动中止维持静默撤回）
- 每次压缩尝试的结果/报错始终写入日志（成功 info / 失败 warn，不受 `debug` 影响）；失败原因为说明具体问题的文案（如缺少 `<history>` 块、条目 index 不连续），不再输出解析器原始报错；xmldom 非致命解析消息不再走 console，模型下载日志只走日志门面

### Fixed

- 观察判定（`observePass`）的净压力在「上下文压力 − 已压缩 `<history>` 块」基础上额外扣除系统提示词 token 估算（按 agent 作用域组装渲染系统提示词后按长度/4 计），避免净压力高估导致观察偏早触发；宿主未提供 `systemPrompt` 服务或组装/渲染失败时按 0 计并输出 warn 日志

### Changed

- 摘要生成上限（`compressMaxTokens`）默认改为不设置——默认不向摘要请求发送 `maxTokens`，由模型适配器默认值决定；显式配置整数时按原样生效，载荷与日志中该字段省略/显示为未设置
