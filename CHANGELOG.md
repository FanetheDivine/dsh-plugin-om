# Changelog

## Unreleased

### Changed

- 压缩机制改为工具驱动：摘要生成走多轮工具会话，模型经 getHistory 查看区间条目、compressHistory 分批替换 assistant 条目、completeCompression 结束；首条 user 消息仅含压缩指令与 index 区间，不含历史消息内容。用户消息与系统消息不可压缩且原样保留，未压缩条目原样保留；skill 块首次压缩时要求模型再次确认相关性；最终 `<history>` 块由插件从视图与替换记录构建，移除直出校验与模糊重建链路（summarize.ts）
- 每次压缩的工具循环完整对话落盘为 one-shot 子会话（compaction-log.ts）：成功为会话记录、失败为失败日志，替代原「逐尝试提示词 + 原始输出」诊断格式
- 压缩失败语义变更：模型连续 2 轮不调用压缩工具或请求级错误（非 429、非 signal 中止）即判失败，无插件级整体重试；429 仍走全局限流等待门
- 移除配置项 `compressRetryCount`（无对应语义）；`compressMaxTokens` 变为压缩循环单轮生成上限
- 客户端压缩卡片的 attemptCount 语义从摘要重试次数改为压缩循环轮数，文案改为「N 轮」

### Added

- 新增 `src/compress-view.ts`（压缩视图：观察与反思区间到统一条目序列的投影与渲染）、`src/compress-tools.ts`（压缩工具状态机与最终块构建）、`src/compress-loop.ts`（工具压缩循环引擎）

### Changed（早前）

- 反思压缩把全部 `<history>` 块内文拼合为单个块送入摘要调用，替代多个块直接拼接；拼合时剥离各块块首格式说明注释，正文条目内的同名串保留
- 按新文档规范优化 README：一句话功能概况加提纲式分节，去括号与破折号，文件地图补齐 `src/json-schema.ts`
- AGENTS.md 文档规范明确 README 需一句话描述功能概况，不使用括号和破折号
