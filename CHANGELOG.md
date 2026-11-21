# Changelog

## 未发布

- 修复压缩 provider 传输挂起时 pre-step 无限阻塞导致会话卡死：新增 `observeWaitMaxMs`（默认 60000），等待超限或后台任务超时后本轮继续，任务留在后台。
