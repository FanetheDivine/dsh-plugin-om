# Changelog

- 压缩进行中在消息列表显示「正在压缩上下文（观察/反思）…」提示行（compaction/start 提前到摘要调用前、载荷带 phase，失败补 end(error) 后撤回）
- 压缩卡片标题在重试次数 > 0 时显示「重试 N 次」（summary 载荷 attemptCount 扩展）
