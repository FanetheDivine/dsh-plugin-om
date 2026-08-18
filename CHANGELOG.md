# Changelog

## Unreleased

- feat: 配置键 summaryMode 移除、改为 omEnabled（仅开关自动压缩）——摘要始终以 new 方式开启观察（新开会话、指令作为 system、被压缩消息渲染为输入），删除全部 fork 模式代码（fork 虽复用主会话前缀缓存，但需模型自行对消息计数，导致严重索引异常）
- feat: 配置宽松化——不合法的配置键被忽略、不合法的值回退默认值，不再在插件加载时报错
- docs: README 配置项一节说明 omEnabled 替代 summaryMode 及原因；同步文件地图与测试数量
- 优化skills
