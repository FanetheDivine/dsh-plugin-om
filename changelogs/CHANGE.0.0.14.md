# Changelog

## [0.0.14] - 2026-08-19

## Unreleased

- feat: 压缩日志标签 <om-history> 改为 <history>——输入与输出均为合法的 <history> 块；观察输入渲染为 <history> 块（用户消息文本原样、图片/文件以注释补充，assistant 的 reasoning/text/toolcall&result 原样）
- feat: 观察与反思共用同一套系统提示词（buildHistoryPrompt）：先定义 history 块（模型消息 + index 的表达形式）、要求压缩（完整保留用户消息 / reasoning 仅参考产物无 / 关联 assistant 合并 / index/start/end 连续）、再给出数据源；反思把多个 <history> 块拼接传给模型
- feat: 摘要输出连续性校验——合法 <history> 块、不含 <reasoning> 块、index/start/end 连续且覆盖预期区间，不合法视为失败重试
- feat: 新增配置 compressRetryCount（默认 10）：摘要调用失败后的最大重试次数（不含首次；总尝试次数 = 该值 + 1）
- feat: 压缩边界简化——消息列表中最后一个合法 <history> 块（source 为插件）之后视为未压缩，其前（含自身）视为已压缩；未闭合（无 result）的 tool-call 不占完整消息 index
- feat: 「完整消息」定义统一为固定字符串（`用户消息`，`模型输出文本`和`具有result的toolcall`被视作`完整消息`。首条`完整消息`的index是0，后续的index递增。），提示词 / recall / recall-semantic / 块顶注释共用
- docs: README 同步压缩日志块结构、配置项（compressRetryCount）、文件地图与测试数量

- feat: 配置键 summaryMode 移除、改为 omEnabled（仅开关自动压缩）——摘要始终以 new 方式开启观察（新开会话、指令作为 system、被压缩消息渲染为输入），删除全部 fork 模式代码（fork 虽复用主会话前缀缓存，但需模型自行对消息计数，导致严重索引异常）
- feat: 配置宽松化——不合法的配置键被忽略、不合法的值回退默认值，不再在插件加载时报错
- docs: README 配置项一节说明 omEnabled 替代 summaryMode 及原因；同步文件地图与测试数量
- 优化skills
