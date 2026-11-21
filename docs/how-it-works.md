# 工作机制

## 插件行

- 单包两行，各行在插件页单独启停。
- 包根行 `dsh-plugin-om` 提供压缩、`recall` 与全部浏览器界面。
- 评估行 `dsh-plugin-om-compaction-eval` 提供 `/om-compaction-eval`。
- 包根行服务端必需 `llm` 和 `tokenMeter`。`tools` 和 `sessions` 缺失时，对应的 `recall` 和压缩会话记录停用并输出 warning，压缩照常运行。评估行只依赖 `commands`。

## 完整消息

- 完整消息定义写在 history 与 archived-history 块顶注释和 recall 工具描述中。
- 手动加载的 skill 计入完整消息，其余系统消息不占 index。
- recall 与压缩共用同一套编号。

## 观察压缩

- 主会话未压缩内容达到 `observeThresholdTokens` 时立即开始后台预压缩。
- 后台任务与等待注入都受 `observeWaitMaxMs` 约束：等待超限或任务超时（传输挂起）时本轮继续，压缩失败按下个 pre-step 重试。
- 结果持久化到会话日志，新增完整消息达到 `tailMessageCount` 后注入，重启后直接采纳已有结果。
- 通过工具循环生成摘要，保留用户消息和未压缩内容。
- 压缩会话首条消息附带区间全部条目，模型首轮即可提交全部摘要并完成。
- 压缩循环中 `getHistory` 返回当前状态，本次已压缩的区间显示为摘要条目。
- 同轮有失败的摘要或问答重写未修正时，`completeCompression` 不执行。
- 连续 3 轮不调用工具或连续 3 轮被 max-tokens 截断才判失败，两者分开计数。
- 遇到 5xx 或网络错误时最多重试 3 次，等待复用 429 限流门。
- 保留工具加载与手动加载的 skill 原文，并在压缩前再次确认。
- 有效提问首次直接压缩需再次确认，保留时重写问答并展开选项引用。
- 中断或错误的提问作为普通工具调用处理。

## 归档

- history 块累计超过 `reflectThresholdTokens` 时，在后台把较早的块归档为 archived-history 块。
- 尾部保留合计不超过阈值三分之一的 history 块。
- 归档块保留用户消息和已处理的提问，相邻用户消息之间的模型内容压成一句话并附 recall 检索关键词。
- 归档不阻塞会话，同一会话同时只运行一个，完成后由下一个 pre-step 提交。
- 被归档块中的 skill 按名称去重，提交时以手动引用 skill 的形式重新注入。

## 进度提醒

- 以 system-reminder 消息要求模型在本会话中用 1-2 句话记录中间结论与下一步规划，记录后继续任务，最终输出另行构建。
- 表层缺少同 kind 进度提醒时补发，不比较文本内容。
- 开启 `progressReminderIdleEnabled` 后，最近一次真实用户消息、非空模型文本、`ask_user_question` 调用或进度提醒之后，表层累计至少 `progressReminderIdleSteps` 个已结束模型 step 且工具调用超过 `progressReminderIdleToolCalls` 次时重发，并要求立刻输出记录。

## Claude thinking 签名

压缩后发给 Claude 的请求剥离保留尾部中压缩前生成的 thinking 签名，避免前缀变化导致签名校验失败。限制见 [known-risks.md](./known-risks.md)。

## recall

- 按消息序号回看原文。
- 用 `query` 检索。启用语义增强时用本地嵌入模型按含义匹配，关闭时按字符串匹配。
- 开启语义增强后，插件启动即在后台下载嵌入模型，未就绪时语义检索返回提示。直连 HuggingFace 受限时设置 `HF_ENDPOINT` 走镜像。

## 压缩会话记录

- 落盘完整压缩循环，以宿主原生时间线展示逐轮耗时与 token 用量。
- 尾部追加压缩模型、思考等级、原始与产物字符数，单位与卡片一致。失败时附原因、最后一轮 finish 与输出 token 数。
- 显示在子智能体列表，标题为 `OM会话(起点-终点)-观察/反思`，重压缩与失败各追加后缀。
- 随父会话 Session 日志一起下载。

## 浏览器界面

- 会话中显示压缩结果、错误和降级警告卡片。
- 包根行配置页在依赖项关闭时隐藏关联项：语义增强关闭隐藏 `modelDir`，长期无记录时重发关闭隐藏两个重发阈值。

## 评估命令

- `/om-compaction-eval` 按 `workspaceId` 在同工作区新建会话，找不到工作区时按 `cwd` 新建，再选择模型并投递首条消息。
- 模型与思考等级默认沿用当前会话，参数 `provider/model [思考等级]` 可覆盖，只给模型时思考等级用模型默认。浏览器中不带参数执行时弹出模型面板。
- 首条消息只给评估文档路径、工作区路径与工作区 id、被分析会话 id，评估步骤由文档决定。
- 浏览器监听到命令成功后跳转到新会话，其他客户端在会话列表中打开它。
- 评估文档与脚本随包发布在 `dist/skill/compaction-eval`。脚本是自包含 `.mjs`，只需 Node。
- 评估产物写系统临时目录 `om-compaction-eval/`，不写工作区。
