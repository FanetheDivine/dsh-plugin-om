# Changelog

## 未发布

- 修复压缩 provider 传输挂起时 pre-step 无限阻塞导致会话卡死：新增 `observeWaitMaxMs`（默认 60000）限制 pre-step 等待，超时本轮继续、后台压缩不受影响。
- 新增 `observeJobMaxMs`（默认 900000）作为后台压缩自身的总时长上限，到点才中止任务，挂起的传输随之结算。
- 压缩失败不再拒绝本 step 中断 turn，改为退避重试；退避按 `observeRetryBackoffMs`（默认 60000）的 1×/5×/15× 封顶。
- 待定标记连续失败达 `observeMaxFailures`（默认 3）或存活超过 `observePendingExpireMs`（默认 1 小时）时自动失效。
- 限流冷却时长按 `RATE_LIMIT_WAIT_MS_MAX`（1 小时）钳制，配置过大不会让压缩长期停摆。
