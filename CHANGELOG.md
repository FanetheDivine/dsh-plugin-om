# Changelog

## Unreleased

- feat: 观察压缩触发压力扣除已压缩摘要——触发条件由「上下文压力 ≥ `observeThresholdTokens`」改为「净压力 = 上下文压力（`ctx.tokenMeter.measure(session).totalTokens`）− 已压缩 <history> 块 token 估算合计（4 字符 ≈ 1 token，与反思同口径）≥ `observeThresholdTokens`」，观察只压缩新消息、旧摘要块的 token 不再挤占触发预算；默认值与配置键不变，跳过/触发/完成日志改为输出净压力及压力构成

- feat: recall / recall-semantic 输出携带完整消息中的图片附件——输出值从纯文本改为 `{ text, images }`（`text` 为渲染文本，带图消息在文本后附图片附件标注行；`images` 为图片附件元数据，经 `output.render` 投影为图片内容块，按 attachmentId 引用、不复制字节）；图片收集覆盖消息顶层与 tool-result 嵌套（pruner 裁剪掉的内容不收集）；recall-semantic 匹配行为不变——只按文本匹配，纯图片消息不进候选池，工具 description 说明该限制
- fix: 分块合并摘要不再重复格式说明注释/产生多余空行——tip 属性与格式说明注释（`<!-- 完整消息：… -->`）改为最终装配：观察分块摘要的中间产物不加工（`extractSummaryLog` 新增 `decorate` 选项，分块路径传 `false`，`runSummarySubagent` 选项透传），由 `mergeChunkReports` 在合并块顶统一添加一次；合并时防御性剥离各块内层已有注释、清除内层首尾空白并按单换行拼接（连续多行空行压成单个空行）
- feat: 观察压缩触发口径改为宿主 token-meter 上下文压力——`observeThresholdTokens` 由「未压缩消息 token 估算」改为衡量 `ctx.tokenMeter.measure(session).totalTokens`（provider 真实 usage 优先：最近一次成功调用的上报值锚定 + 表层增量；不可信时回退启发式），默认值保持 100000；删除不再使用的 `measureUncompressedTokens`；压缩提交侧 shadow-price 计量（启发式）不变
