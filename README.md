# dsh-plugin-om

[![npm version](https://img.shields.io/npm/v/dsh-plugin-om.svg)](https://www.npmjs.com/package/dsh-plugin-om)

让 DSH 的长会话不再撑爆上下文。插件在后台把较早的对话压缩成摘要，保留你的原话，模型需要时还能找回原文。设计参考 [Observational Memory](https://mastra.ai/research/observational-memory)。

## 功能

- **自动压缩**：上下文变大后在后台压缩较早的对话，不打断当前任务。
- **保留关键内容**：你发的消息、问答结果和加载的 skill 保持原文，模型的过程被压成摘要。
- **找回原文**：模型可调用 `recall` 工具，按序号或关键词回看被压缩的原文，支持按含义检索。
- **进度提醒**：提醒模型随手记下中间结论和下一步，压缩后不丢方向。
- **压缩卡片**：会话中显示每次压缩的结果与错误，可打开压缩过程查看耗时和 token 用量。
- **质量评估**：`/om-compaction-eval` 新建会话，由 AI 分析当前会话的压缩质量。

## 安装

```sh
dsh plugin --profile <profile> add dsh-plugin-om
```

- 需要 DSH 0.2.1-rc.2 或更高版本。
- 安装后插件页出现两行，可单独启停：
  - `dsh-plugin-om`：压缩、`recall` 与界面。关闭即停止压缩。
  - `dsh-plugin-om-compaction-eval`：评估命令。
- pnpm 11 安装失败时，在 profile 的 `pnpm-workspace.yaml` 中设置 `allowBuilds: true`，或允许 `onnxruntime-node`、`protobufjs` 和 `sharp` 构建。

## 配置

在 WebUI 插件侧边栏打开 `dsh-plugin-om` 的配置页修改，保存后立即生效。也可编辑 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`，`$DSH_HOME` 默认为 `~/.dsh`：

```yaml
- id: dsh-plugin-om
  config:
    observeThresholdTokens: 55000
```

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `observeThresholdTokens` | `55000` | 未压缩内容达到该 token 数时开始压缩 |
| `reflectThresholdTokens` | `120000` | 压缩摘要累计达到该 token 数时，把较早的摘要进一步归档 |
| `tailMessageCount` | `20` | 压缩时保留最近多少条消息不动 |
| `observeWaitMaxMs` | `60000` | 等待后台压缩的上限毫秒数，超时本轮继续、压缩留在后台；`0` 不设上限 |
| `semanticRecallEnabled` | `true` | `recall` 是否按含义检索，关闭后按关键词匹配 |
| `modelDir` | DSH 共享目录 | 语义检索模型的存放目录 |
| `compressProvider` | 当前会话 | 压缩用的 provider，需与 `compressModel` 一起配置 |
| `compressModel` | 当前会话 | 压缩用的模型，需与 `compressProvider` 一起配置 |
| `compressReasoningEffort` | 模型默认 | 压缩模型的思考等级 |
| `compressMaxTokens` | 模型默认 | 压缩模型单轮最大输出 |
| `compressSkipReasoning` | `true` | 压缩时忽略模型的思考内容 |
| `rateLimitWaitMs` | `60000` | 遇到限流或服务端错误时的重试等待毫秒数，`0` 不等待 |
| `progressReminderEnabled` | `true` | 是否启用进度提醒 |
| `progressReminderIdleEnabled` | `false` | 模型长时间没有记录进度时是否再次提醒 |
| `progressReminderIdleSteps` | `4` | 再次提醒前至少经过的模型步数 |
| `progressReminderIdleToolCalls` | `10` | 再次提醒前需超过的工具调用次数 |
| `debug` | 开发环境启用 | 输出调试日志 |

调参建议：

- 阈值按主模型的 token 计。调小更省上下文，调大摘要信息更多。
- 调大 `tailMessageCount` 会推迟首次压缩，保留更多原文。
- 想降低成本，可通过 `compressProvider` 和 `compressModel` 指定更便宜的模型。
- 只有模型思考内容里有关键决策时，才把 `compressSkipReasoning` 设为 `false`。
- 用[成本计算器](https://fanethedivine.github.io/dsh-plugin-om/)估算不同配置的 token 成本。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/om-compaction-eval [provider/model [思考等级]]` | 在同工作区新建会话，分析当前会话的压缩质量 |

- 需启用 `dsh-plugin-om-compaction-eval` 行。
- 默认沿用当前会话的模型。在浏览器中不带参数执行时弹出模型选择面板。
- 执行后自动跳转到新会话，评估产物写入系统临时目录，不写工作区。

## 注意事项

- 压缩会额外调用模型，产生 token 费用。
- 开启语义检索后，插件会在后台下载约 113MB 的嵌入模型，下载完成前语义检索不可用。访问 HuggingFace 受限时设置环境变量 `HF_ENDPOINT=https://hf-mirror.com`。
- 使用 Claude 时，压缩后插件会移除旧的 thinking 签名，宿主的请求查看显示的是移除前的内容。
- 归档后重新注入的 skill 可能被模型当作新指令再次执行。
- 压缩状态写入会话日志，压缩过程记录随会话日志一起下载。
