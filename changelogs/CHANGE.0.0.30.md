# Changelog

## [0.0.30] - 2026-09-06

## Unreleased

### Changed

- 压缩机制改为工具驱动：摘要生成走多轮工具会话，模型经 getHistory 查看区间条目、compressHistory 分批替换 assistant 条目、completeCompression 结束；首条 user 消息仅含压缩指令与 index 区间，不含历史消息内容。用户消息与系统消息不可压缩且原样保留，未压缩条目原样保留；skill 块首次压缩时要求模型再次确认相关性；最终 `<history>` 块由插件从视图与替换记录构建，移除直出校验与模糊重建链路（summarize.ts）
- 每次压缩的工具循环完整对话落盘为 one-shot 子会话（compaction-log.ts）：成功为会话记录、失败为失败日志，替代原「逐尝试提示词 + 原始输出」诊断格式
- 压缩失败语义变更：模型连续 2 轮不调用压缩工具或请求级错误（非 429、非 signal 中止）即判失败，无插件级整体重试；429 仍走全局限流等待门
- `compressSkipReasoning` 作用于工具循环：`true`（默认）时 getHistory 输出不含 `<reasoning>` 参考条目，压缩指令同步省略其说明行
- 移除配置项 `compressRetryCount`（无对应语义）；`compressMaxTokens` 变为压缩循环单轮生成上限
- 客户端压缩卡片的 attemptCount 语义从摘要重试次数改为压缩循环轮数，文案改为「N 轮」
- om 私有事件（警告与观察压缩标记）改借 `feedback/record` 信封承载（`src/om-event.ts`），修复含 om 事件的会话无法加载
- 诊断子会话 label 改为 `OM 压缩会话记录/失败日志（<阶段> · N 轮）`
- 成本计算器适配工具驱动压缩：参数面板移除每轮 thinking / 每轮 tool result / 压缩 thinking / OM token消耗比，上下文按每 step 800 token 输入均匀增长，压缩会话按经验公式计费（缓存创建 ≈ 1.3×输入、缓存读 ≈ 1.75×输入、输出 ≈ 压缩比×输入 + 5,000），表格假设移至表下列出

### Added

- 新增 `src/compress-view.ts`（压缩视图：观察与反思区间到统一条目序列的投影与渲染）、`src/compress-tools.ts`（压缩工具状态机与最终块构建）、`src/compress-loop.ts`（工具压缩循环引擎）
- 新增 `src/om-event.ts`：om 事件借用 feedback/record 信封的编解码与读写

### Changed（早前）

- 反思压缩把全部 `<history>` 块内文拼合为单个块送入摘要调用，替代多个块直接拼接；拼合时剥离各块块首格式说明注释，正文条目内的同名串保留
- 按新文档规范优化 README：一句话功能概况加提纲式分节，去括号与破折号，文件地图补齐 `src/json-schema.ts`
- AGENTS.md 文档规范明确 README 需一句话描述功能概况，不使用括号和破折号
- 成本计算器把每轮新增 tokens 拆分为 thinking 与 tool result 两个参数：thinking 只计补全价，tool result 只写入缓存并驱动上下文增长
- 成本计算器计入摘要调用自身的 thinking：按摘要输入 tokens 的 50% 折算并按补全价计费，不写入缓存；成本表假设区同步展示该口径
