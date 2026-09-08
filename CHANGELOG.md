# Changelog

## Unreleased

- `recall` 与 `recall-semantic` 工具描述补充调用时机说明，引导模型在需要查看或按语义检索历史消息时主动调用

- README 配置表格下方补充 `tailMessageCount` 说明：检测到未压缩消息到达观察阈值后，插件会等待至少 tailMessageCount 后再压缩之前的消息，该配置影响首次压缩时机，也可以保留更多会话信息
