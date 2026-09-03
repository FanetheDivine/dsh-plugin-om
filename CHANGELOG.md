# Changelog

## Unreleased

- feat: 摘要输出校验放宽为模糊提取，不再要求模型输出整体合法 XML——取首个 `<history>` 开标签（允许带属性）到最后一个 `</history>` 定位候选块，整块非法时按条目标签（user_message/sys/assistant/reasoning）字符串级扫描配对并重建为合法块（未闭合条目以文本末尾收口、未知元素与杂文忽略、转义形式解码后归一），随后仍校验无 reasoning、index 连续与 expected 覆盖区间，可恢复的输出不再触发无效重试
- feat: 观察阈值（`observeThresholdTokens`）默认改为 35000 tokens、尾部保留条数（`tailMessageCount`）默认改为 5、摘要最大重试次数（`compressRetryCount`）默认改为 5
- docs: 精简 README 与代码注释——README 提纲挈领只描述功能概况（保留文件地图），注释统一为静态描述（文件头说明功能与关键导出项，函数/常量简注功能），并新增 AGENTS.md 文档与注释规范
- feat: 观察阈值默认改为 30000 tokens、反思阈值默认改为 40000 tokens
- refactor: 观察压缩采用单次摘要——未压缩消息不再按 token 边界分块并行压缩，观察/反思共用同一套系统提示词与 `compressMaxTokens`；删除 `observeChunkTokens` / `observeChunkMaxTokens` / `observeChunkParallelism` 配置项
- feat: 观察压缩触发压力扣除已压缩摘要——触发条件由「上下文压力 ≥ `observeThresholdTokens`」改为「净压力 = 上下文压力（`ctx.tokenMeter.measure(session).totalTokens`）− 已压缩 <history> 块 token 估算合计（4 字符 ≈ 1 token，与反思同口径）≥ `observeThresholdTokens`」，观察只压缩新消息、旧摘要块的 token 不再挤占触发预算；默认值与配置键不变，跳过/触发/完成日志改为输出净压力及压力构成

- feat: recall / recall-semantic 输出携带完整消息中的图片附件——输出值从纯文本改为 `{ text, images }`（`text` 为渲染文本，带图消息在文本后附图片附件标注行；`images` 为图片附件元数据，经 `output.render` 投影为图片内容块，按 attachmentId 引用、不复制字节）；图片收集覆盖消息顶层与 tool-result 嵌套（pruner 裁剪掉的内容不收集）；recall-semantic 匹配行为不变——只按文本匹配，纯图片消息不进候选池，工具 description 说明该限制
- feat: 观察压缩触发口径改为宿主 token-meter 上下文压力——`observeThresholdTokens` 由「未压缩消息 token 估算」改为衡量 `ctx.tokenMeter.measure(session).totalTokens`（provider 真实 usage 优先：最近一次成功调用的上报值锚定 + 表层增量；不可信时回退启发式），默认值保持 100000；删除不再使用的 `measureUncompressedTokens`；压缩提交侧 shadow-price 计量（启发式）不变
