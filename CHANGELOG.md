# Changelog

## Unreleased

- feat: 观察压缩多块并存——旧 <om-history> 块保留为独立消息，新摘要只精确替换被压缩的新消息区间（历史不再随压缩次数膨胀，前缀缓存保留到旧块处）
- feat: 压缩日志块结构——去掉注入前缀句，对 AI 的提醒移至 <om-history tip> 属性，块顶构成逻辑注释保持不变
- fix: 压缩日志定位修复——旧格式注入前缀句中的行内 <om-history> 不再抢先命中 historyTextOf（兼容旧会话残留消息）
- feat: 反思合并全部 <om-history> 块——按全部块总长触发阈值，把整个块区段合并为一条
