# dsh-plugin-om

[![npm version](https://img.shields.io/npm/v/dsh-plugin-om.svg)](https://www.npmjs.com/package/dsh-plugin-om)

为 DSH 提供 [Observational Memory](https://mastra.ai/research/observational-memory) 风格的上下文压缩和原文召回。

## 功能

- 自动压缩主会话历史，并在摘要过大时再次合并
- OM 启用时以 system-reminder 消息要求模型在本会话中用 1-2 句话记录中间结论与下一步规划，记录后继续任务，最终输出另行构建
- 表层缺少同 kind 进度提醒时补发，不比较文本内容
- 最近真实用户消息、非空模型文本、`ask_user_question` 调用或进度提醒之后，开启 `progressReminderIdleEnabled` 且表层活动累计至少 `progressReminderIdleSteps`（默认 4）个已结束模型 step、工具调用超过 `progressReminderIdleToolCalls`（默认 10）次时重发，并要求立刻输出记录
- 完整消息定义写在 history 块顶注释和 recall 工具描述中
- 通过工具循环生成摘要，保留用户消息和未压缩内容；系统消息不占完整消息 index
- 保留工具加载的 skill 原文，并在压缩前再次确认
- 有效提问首次直接压缩需再次确认，保留时查看选项后在下一轮重写问答并展开选项引用
- 中断或错误的提问作为普通工具调用处理
- 使用 `recall` 按消息序号回看原文，启用语义增强后还可按含义检索
- 压缩会话记录落盘完整循环，以宿主原生时间线展示逐轮耗时与 token 用量
- 压缩会话记录尾部追加模型文本：压缩模型、思考等级、原始与产物字符数（k/w/M 单位，与卡片一致）
- 压缩会话记录显示在子智能体列表，随父会话 Session 日志一起下载
- 在浏览器中显示压缩结果、错误和降级警告
- 压缩卡片可换模型重压缩，可多选模型和思考等级，一次提交按组合并行运行，超出并发上限的排队，进行中显示所用模型，结果只写入压缩会话记录，用于对比不同模型的压缩效果

## 安装

要求 DSH 0.2.0-rc.2 或更高版本。

```sh
dsh plugin --profile <profile> add dsh-plugin-om
```

重启 DSH 后检查配置：

```sh
dsh --profile <profile> --dump-config
```

pnpm 11 安装失败时，在 profile 的 `pnpm-workspace.yaml` 中设置 `allowBuilds: true`，或允许 `onnxruntime-node`、`protobufjs` 和 `sharp` 构建。

## 配置

在 WebUI 插件侧边栏打开 `dsh-plugin-om` 行配置页，或编辑 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`。配置支持热更新，`$DSH_HOME` 默认为 `~/.dsh`。

```yaml
- id: dsh-plugin-om
  config:
    observeThresholdTokens: 35000
```

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `observeThresholdTokens` | `35000` | 观察压缩阈值 |
| `reflectThresholdTokens` | `40000` | 摘要合并阈值 |
| `tailMessageCount` | `20` | 触发后保留的完整消息数 |
| `compressMaxTokens` | 模型默认值 | 单轮生成上限 |
| `compressProvider` | 会话路由 | 压缩 provider，需与 `compressModel` 同时配置 |
| `compressModel` | 会话路由 | 压缩模型，需与 `compressProvider` 同时配置 |
| `compressReasoningEffort` | 模型默认值 | 思考等级 |
| `compressSkipReasoning` | `true` | 是否忽略 reasoning |
| `rateLimitWaitMs` | `60000` | 429 后的等待毫秒数，`0` 表示不等待 |
| `recompressConcurrency` | `2` | 重压缩同时运行的上限，至少为 `1`，超出的排队 |
| `modelDir` | DSH 共享目录 | 嵌入模型目录 |
| `omEnabled` | `true` | 是否启用自动压缩，关闭后进度提醒也不再注入 |
| `progressReminderEnabled` | `true` | 是否注入进度提醒，需同时开启 `omEnabled` |
| `progressReminderIdleEnabled` | `false` | 长期无记录时是否重发进度提醒，关闭后仅在提醒缺失时补发 |
| `progressReminderIdleSteps` | `4` | 无记录的已结束 step 数达到该值才重发，至少为 `1` |
| `progressReminderIdleToolCalls` | `10` | 无记录期间工具调用数超过该值才重发，至少为 `0` |
| `recallEnabled` | `true` | 是否启用原文召回 |
| `semanticRecallEnabled` | `true` | 是否为 `recall` 启用语义增强，依赖 `recallEnabled` |
| `debug` | 开发环境启用 | 是否输出步骤日志 |

配置页在依赖项关闭时隐藏关联项：原文召回关闭隐藏语义增强，语义增强未生效隐藏 `modelDir`，长期无记录时重发关闭隐藏两个重发阈值。

较小的观察阈值更早节省上下文，较大的阈值提供更多摘要信息。只有 reasoning 包含关键决策时才需将 `compressSkipReasoning` 设为 `false`。

[机制说明与成本计算器](https://fanethedivine.github.io/dsh-plugin-om/)可估算不同配置的 token 成本。

## 已知风险

- 宿主会拒绝加载含未知事件类型的会话，插件也无法为事件标记 `ignorable`。
- 因此观察待定标记和降级警告借用宿主已知的 `feedback/record` 事件写入会话日志。
- 宿主把 `feedback/record` 视为用户反馈。遥测为默认的 `FEEDBACK_ONLY` 模式时，含这类记录的会话日志会上传到 DeepSeek 遥测服务。
- 不希望上传时，设置环境变量 `DSH_TELEMETRY_MODE=DISABLED` 后启动 DSH。

## 开发

运行 `pnpm dev` 自动构建，并在 `cordis.patch.yml` 中加载本地 bundle：

```yaml
- insert:
    - id: dsh-plugin-om-dev
      name: file:///<repo>/dist/index.mjs
```

语义增强首次使用时自动下载嵌入模型，也可运行 `pnpm run download:model` 预下载。

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | 监听并构建 |
| `pnpm check` | 检查类型、lint、测试和构建 |
| `pnpm test` | 运行测试 |
| `pnpm run download:model` | 预下载嵌入模型 |
| `pnpm run release` | 检查并发布新版本 |

## 文件地图

```text
cordis.patch.yml                 # bundle patch，dsh plugin add 后作为组合层插入插件行
src/
├── index.ts                     # 打包入口：注册 recall 工具并接线自动压缩和提醒补发
├── system-reminder.ts           # 进度提醒：system-reminder 消息的构造与缺失时补发
├── config.ts                    # 配置默认值与宽松合并，未知键忽略、非法值回退默认
├── constants.ts                 # 共享常量：插件标识、history 标签、完整消息定义、格式说明注释
├── degrade.ts                   # 挂载失败降级上报：console 外部输出与 om/warning 会话事件
├── om-event.ts                  # om 事件借用通道：feedback/record 信封的编解码与读写
├── types.ts                     # type-only：宿主类型再导出与领域类型
├── utils.ts                     # 零依赖工具函数：文本渲染、主会话判定、路由解析
├── json-schema.ts               # zod schema 到工具 wire 参数 JSON Schema 的转换
├── logger.ts                    # 插件日志门面，step 按 debug 开关过滤
├── rate-limit.ts                # 全局 429 限流冷却门，进程级共享状态
├── log-index.ts                 # 完整消息索引与渲染，recall 与压缩共用同一套编号
├── recall.ts                    # recall 工具：按 index 区间回看，启用语义增强时支持 query
├── recall-xml.ts                # 完整消息到 CDATA 包裹 XML 条目的渲染，recall 与语义检索共用
├── recall-output.ts             # recall 输出契约：{ text, images } 与 render 投影
├── semantic-recall.ts           # recall 语义增强：本地嵌入语义检索实现
├── embedding.ts                 # 本地 ONNX 嵌入：懒加载、批量、运行时按需下载编排
├── model-download.ts            # 模型下载原语：URL、跳过判定、原子落盘
├── compress-view.ts             # 压缩视图：观察与反思投影、有效提问配对与选项展示
├── compress-tools.ts            # 压缩工具状态机：查看、压缩、问答重写、完成门禁与最终块构建
├── compress-loop.ts             # 工具压缩循环：条件提示、多轮请求、工具执行、限流、失败判定与统计
├── compaction-log.ts            # 压缩会话记录落盘：seed 重建时间线与逐轮 usage 的诊断子会话
├── compress.ts                  # 两级自动压缩：观察、反思、失败传播与生命周期事件
├── recompress.ts                # 换模型重压缩：按压缩 id 重放视图并落盘记录，附内部命令
├── recompress-gate.ts           # 重压缩并发信号量：按配置上限排队许可
└── client/                      # 浏览器客户端 bundle：压缩卡片与插件行配置
    ├── index.ts                 # 注册卡片、渲染器与行配置槽
    ├── om-config-controller.ts  # 宿主配置表单、草稿和原子保存
    ├── OmConfigCard.tsx         # 十九项双语配置控件
    ├── definition.ts            # 压缩卡片定义：生命周期事件、检查点替换与警告事件
    ├── OmCompactionCard.tsx     # 压缩结果与错误卡片，可跳转轨迹与诊断子会话
    ├── OmRecompressMenu.tsx     # 重压缩模型多选菜单，复用宿主会话模型目录
    ├── recompress-inject.ts     # 装配模型目录与命令通道
    ├── recompress-run.ts        # 重压缩命令行拼装、组合展开与结果归一化
    ├── OmWarningCard.tsx        # 功能降级警告行
    ├── format.ts                # 统计数字紧凑格式化
    └── locales.ts               # 中英文文案
models/                          # 嵌入模型目录
scripts/                         # 下载和发布脚本
tests/                           # 服务端、客户端与集成测试
web/                             # 机制说明与成本计算器站点
    ├── src/model.ts             # 成本模型
    └── src/components/          # 页面组件与 UI 原语
.agents/skills/agent-workflow/SKILL.md # 仓库开发工作流
.agents/skills/clear-branch/SKILL.md   # 手动清空除 main 外的分支与 worktree
.agents/skills/release/SKILL.md        # 手动发布并跟踪 CI 与 npm
.github/workflows/web-deploy.yml # GitHub Pages 部署工作流
```
