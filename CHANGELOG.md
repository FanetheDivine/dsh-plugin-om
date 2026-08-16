# Changelog

- docs: README/文件头注释同步完整消息 index 定位单位（recall / recall-semantic / 摘要日志共用）
- feat: recall-semantic 改用完整消息 index 定位（start/end 数字参数，区间越界回退全量，输出标 index，去 message_id）
- feat: recall 改用完整消息 index 定位（start/end/offset 数字参数，输出标 index/类型，越界提示）
- feat: 摘要日志改用完整消息 index（<user_message index="N"> / <assistant start end> / <assistant index="N"> / toolcall index:<N>，删 message_id 对照表，注入新消息起始 index）
- feat: 完整消息索引（index 定位 user/assistant/toolcall 三类完整消息，recall 与摘要共用；tool/result 按 callId 并入调用条，插件自产消息不占位）
