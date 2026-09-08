# Changelog

## Unreleased

- fix: recall 与 recall-semantic 输出改为 XML 条目序列（`<user_message>`、`<sys>`、`<assistant type="text"|"toolcall">`），正文一律以 CDATA 包裹逐字原样；toolcall 条目内嵌 `<tool-args>`（合法 JSON，仅一层转义）与 `<tool-result>` CDATA 子元素，消除多层转义叠加（如换行符变成 `\\n`）
- fix: recall-semantic 候选池排除本次调用自身的 toolcall 完整消息，避免其渲染文本（含 query 原文）以最高相似度占据 TOP 名额
- `recall` 与 `recall-semantic` 工具描述补充调用时机说明，引导模型在需要查看或按语义检索历史消息时主动调用
- README 配置表格下方补充 `tailMessageCount` 说明：检测到未压缩消息到达观察阈值后，插件会等待至少 tailMessageCount 后再压缩之前的消息，该配置影响首次压缩时机，也可以保留更多会话信息
