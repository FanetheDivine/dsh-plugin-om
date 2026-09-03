# Changelog

## Unreleased

- fix: 分块合并摘要不再重复格式说明注释/产生多余空行——tip 属性与格式说明注释（`<!-- 完整消息：… -->`）改为最终装配：观察分块摘要的中间产物不加工（`extractSummaryLog` 新增 `decorate` 选项，分块路径传 `false`，`runSummarySubagent` 选项透传），由 `mergeChunkReports` 在合并块顶统一添加一次；合并时防御性剥离各块内层已有注释、清除内层首尾空白并按单换行拼接（连续多行空行压成单个空行）
- feat: 观察压缩触发口径改为宿主 token-meter 上下文压力——`observeThresholdTokens` 由「未压缩消息 token 估算」改为衡量 `ctx.tokenMeter.measure(session).totalTokens`（provider 真实 usage 优先：最近一次成功调用的上报值锚定 + 表层增量；不可信时回退启发式），默认值保持 100000；删除不再使用的 `measureUncompressedTokens`；压缩提交侧 shadow-price 计量（启发式）不变
