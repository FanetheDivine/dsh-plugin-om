# Changelog

## 未发布

- 同步 DSH 0.2.2-rc.5 依赖。
- 修复压缩 provider 传输挂起时 pre-step 无限阻塞导致会话卡死：新增 `observeWaitMaxMs`（默认 60000）限制 pre-step 等待，超时本轮继续、后台压缩不受影响。
- 新增 `observeJobMaxMs`（默认 900000）作为后台压缩自身的总时长上限，到点才中止任务，挂起的传输随之结算。
- 压缩失败不再拒绝本 step 中断 turn，改为退避重试；退避按 `observeRetryBackoffMs`（默认 60000）的 1×/5×/15× 封顶。
- 待定标记连续失败达 `observeMaxFailures`（默认 3）或存活超过 `observePendingExpireMs`（默认 1 小时）时自动失效。
- 限流冷却时长按 `RATE_LIMIT_WAIT_MS_MAX`（1 小时）钳制，配置过大不会让压缩长期停摆。
- 限流冷却同时受任务上限钳制，生效值严格小于 `observeJobMaxMs`；`rateLimitWaitMs=0` 仍表示不限流。
- 新增 `observeInvalidateCooldownMs`（默认 600000）作为待定标记失效后的重打标冷却，`0` 表示不冷却；压缩成功的标记退休不冷却。
- 会话销毁时中止后台任务并清除失败记录与失效冷却，任务结算前校验会话存活，不再为已销毁会话写失败记录。
- 压缩循环最终失败不再拒绝本 step，去掉了拒绝中断 turn 的分支与其失败结果类型。
- 压缩提交补写 `compaction/end` 失败时记录告警并重试一次，避免生命周期悬空。
- 待定标记查找与提交路径各只取一次会话快照，避免按节点数重复复制事件数组。
- 观察类数值配置补上 schema 下限 `.min(0)`，非法值回退默认值时按配置键告警一次。
- 嵌入模型下载支持中止：`recall` 的工具取消信号可中断按需下载并清理临时文件。
