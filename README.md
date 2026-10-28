# dsh-plugin-om

[![npm version](https://img.shields.io/npm/v/dsh-plugin-om.svg)](https://www.npmjs.com/package/dsh-plugin-om)

为 DSH 提供 [Observational Memory](https://mastra.ai/research/observational-memory) 风格的上下文压缩和原文召回。

## 功能

- 单包两行，包根行提供压缩、`/om-recompress` 与全部浏览器界面，评估行提供 `/om-compaction-eval`，各行在插件页单独启停
- 自动压缩主会话历史，history 块累计过大时在后台把较早的块归档为 archived-history 块
- 归档块保留用户消息和已处理的提问，相邻用户消息之间的模型内容压成一句话并附 recall 检索关键词
- 归档在后台运行，不阻塞会话，同一会话同时只运行一个，完成后由下一个 pre-step 提交
- 被归档块中的 skill 按名称去重，提交时以手动引用 skill 的形式重新注入
- 观察压缩触发时立即开始后台预压缩，结果持久化到会话日志，新增完整消息达到 `tailMessageCount` 后注入，重启后直接采纳已有结果
- 以 system-reminder 消息要求模型在本会话中用 1-2 句话记录中间结论与下一步规划，记录后继续任务，最终输出另行构建
- 表层缺少同 kind 进度提醒时补发，不比较文本内容
- 最近真实用户消息、非空模型文本、`ask_user_question` 调用或进度提醒之后，开启 `progressReminderIdleEnabled` 且表层活动累计至少 `progressReminderIdleSteps`（默认 4）个已结束模型 step、工具调用超过 `progressReminderIdleToolCalls`（默认 10）次时重发，并要求立刻输出记录
- 完整消息定义写在 history 与 archived-history 块顶注释和 recall 工具描述中
- 通过工具循环生成摘要，保留用户消息和未压缩内容；手动加载的 skill 计入完整消息，其余系统消息不占 index
- 压缩会话首条消息附带区间全部条目，模型首轮即可提交全部摘要并完成
- 压缩循环中 `getHistory` 返回当前状态，本次已压缩的区间显示为摘要条目
- 同轮有失败的摘要或问答重写未修正时，`completeCompression` 不执行
- 压缩循环连续 3 轮不调用工具或连续 3 轮被 max-tokens 截断才判失败，两者分开计数
- 压缩请求遇到 5xx 或网络错误时最多重试 3 次，等待复用 429 限流门
- 保留工具加载与手动加载的 skill 原文，并在压缩前再次确认
- 有效提问首次直接压缩需再次确认，保留时重写问答并展开选项引用
- 中断或错误的提问作为普通工具调用处理
- 压缩后发给 Claude 的请求剥离保留尾部中压缩前生成的 thinking 签名，避免前缀变化导致签名校验失败
- 使用 `recall` 按消息序号回看原文，或用 `query` 检索，启用语义增强时按含义匹配，关闭时按字符串匹配
- 压缩会话记录落盘完整循环，以宿主原生时间线展示逐轮耗时与 token 用量
- 压缩会话记录尾部追加模型文本：压缩模型、思考等级、原始与产物字符数（k/w/M 单位，与卡片一致），失败时附原因、最后一轮 finish 与输出 token 数
- 压缩会话记录显示在子智能体列表，标题为 `OM会话(起点-终点)-观察/反思`，重压缩与失败各追加后缀，随父会话 Session 日志一起下载
- 在浏览器中显示压缩结果、错误和降级警告
- 压缩卡片可换模型重压缩，可多选模型和思考等级，一次提交按组合并行运行，超出并发上限的排队，进行中显示所用模型，结果只写入压缩会话记录，用于对比不同模型的压缩效果
- 提供 `/om-compaction-eval` 命令，由评估行提供，在同工作区新建会话，可选模型与思考等级，不带参数时弹出模型面板，由新会话按随包发布的评估文档分析本会话的压缩结果

## 安装

要求 DSH 0.2.1-rc.2 或更高版本。

包根行服务端必需 `llm` 和 `tokenMeter`。`tools`、`sessions` 和 `commands` 缺失时，对应的 `recall`、压缩会话记录和 `/om-recompress` 停用并输出 warning，压缩照常运行。评估行只依赖 `commands`。

安装后插件页出现 `dsh-plugin-om` 和 `dsh-plugin-om-compaction-eval` 两行，可单独启停。

```sh
dsh plugin --profile <profile> add dsh-plugin-om
```

重启 DSH 后检查配置：

```sh
dsh --profile <profile> --dump-config
```

pnpm 11 安装失败时，在 profile 的 `pnpm-workspace.yaml` 中设置 `allowBuilds: true`，或允许 `onnxruntime-node`、`protobufjs` 和 `sharp` 构建。

## 配置

在 WebUI 插件侧边栏打开目标行的配置页，或编辑 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`。配置支持热更新，`$DSH_HOME` 默认为 `~/.dsh`。

```yaml
- id: dsh-plugin-om
  config:
    observeThresholdTokens: 35000
    recompressConcurrency: 2
```

包根行 `dsh-plugin-om` 配置：

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `observeThresholdTokens` | `35000` | 观察压缩阈值 |
| `reflectThresholdTokens` | `80000` | 归档阈值，尾部保留合计不超过其三分之一的 history 块 |
| `tailMessageCount` | `20` | 触发后保留的完整消息数 |
| `semanticRecallEnabled` | `true` | `recall` 的 `query` 是否按含义检索，关闭时按字符串匹配 |
| `modelDir` | DSH 共享目录 | 嵌入模型目录 |
| `compressProvider` | 会话路由 | 压缩 provider，需与 `compressModel` 同时配置 |
| `compressModel` | 会话路由 | 压缩模型，需与 `compressProvider` 同时配置 |
| `compressReasoningEffort` | 模型默认值 | 思考等级 |
| `compressMaxTokens` | 模型默认值 | 单轮生成上限 |
| `compressSkipReasoning` | `true` | 是否忽略 reasoning |
| `rateLimitWaitMs` | `60000` | 429 与 5xx 重试前的等待毫秒数，`0` 表示不等待 |
| `recompressConcurrency` | `2` | 重压缩同时运行的上限，至少为 `1`，超出的排队 |
| `progressReminderEnabled` | `true` | 是否注入进度提醒 |
| `progressReminderIdleEnabled` | `false` | 长期无记录时是否重发进度提醒，关闭后仅在提醒缺失时补发 |
| `progressReminderIdleSteps` | `4` | 无记录的已结束 step 数达到该值才重发，至少为 `1` |
| `progressReminderIdleToolCalls` | `10` | 无记录期间工具调用数超过该值才重发，至少为 `0` |
| `debug` | 开发环境启用 | 是否输出步骤日志 |

配置页在依赖项关闭时隐藏关联项：语义增强关闭隐藏 `modelDir`，长期无记录时重发关闭隐藏两个重发阈值。

评估行 `dsh-plugin-om-compaction-eval` 没有配置项。

旧版写在包根行上的 `omEnabled` 会被忽略，停止压缩直接关闭 `dsh-plugin-om` 行。`/om-compaction-eval` 迁到评估行，关闭评估行即停用该命令。

`observeThresholdTokens` 和 `reflectThresholdTokens` 按主模型真实 token 计。较小的观察阈值更早节省上下文，较大的阈值提供更多摘要信息。只有 reasoning 包含关键决策时才需将 `compressSkipReasoning` 设为 `false`。

[机制说明与成本计算器](https://fanethedivine.github.io/dsh-plugin-om/)可估算不同配置的 token 成本。

## 已知风险

### 归档与 skill 注入

- 注入的 skill 与用户手动引用 skill 无法区分，主模型可能把它当成新指令重新执行 skill 流程。
- 压缩会话把 skill 当普通内容处理，观察阶段可能已把 skill 压成摘要，归档时提取不到，原文只能用 recall 找回。
- 归档运行期间若 history 块变化，提交前校验失败，本次结果丢弃，下次检测重新归档。
- 归档结果只存内存，进程重启后重新检测。

### 写入 plugin record

观察待定标记、预压缩结果和降级警告经宿主 `appendPluginRecord` 写入会话日志，类型为 `plugin:dsh-plugin-om/*` 的 ignorable 记录。该 API 属宿主实验性接口，格式迁移时记录只尽力保留，丢失后预压缩结果重新压缩，待定标记重新触发。

从 0.0.60 起，插件不再借用 `feedback/record` 事件：

- om 事件不向后兼容。旧版本写入 `feedback/record` 的 `om:1:` 信封不再识别，旧会话里未完成的观察待定、预压缩结果和降级警告行失效。
- 要求 DSH 0.2.1-rc.2 或更高版本，更低版本没有 `appendPluginRecord`。

### 改写 Claude 请求

Claude 的 thinking 签名绑定其前全部内容，宿主也未开放 `drop_block`。因此插件在 `llm/stream` 中改写请求，剥离压缩前生成的签名。

改写后的请求仍由会话日志确定，但宿主请求查看显示的是改写前的内容。

插件与宿主加载的 `dsh-llm` 不是同一份时，改写后的请求会丢失 agent loop 标记，这次请求不触发会话标题生成。

未强制校验签名的旧账号同样会剥离，压缩后尾部的 reasoning 不再发给 Claude。

## 命令

| 命令 | 提供行 | 作用 |
| --- | --- | --- |
| `/om-recompress <compactionId> <provider> <model> [思考等级]` | `dsh-plugin-om` | 用另一模型重放一次已有压缩，结果只写入压缩会话记录 |
| `/om-compaction-eval [provider/model [思考等级]]` | `dsh-plugin-om-compaction-eval` | ai分析OM结果 |

命令只在对应行启用时注册。

评估命令在会话中执行后，插件按 `workspaceId` 在同工作区新建会话，找不到工作区时按 `cwd` 新建，再选择模型并投递首条消息。模型与思考等级默认沿用当前会话，参数 `provider/model [思考等级]` 可覆盖，只给模型时思考等级用模型默认。消息只给评估文档路径、工作区路径与工作区 id、被分析会话 id，评估步骤由文档决定。浏览器监听到命令成功后跳转到新会话，其他客户端在会话列表中打开它。

评估文档与脚本随包发布在 `dist/skill/compaction-eval`。脚本是自包含 `.mjs`，用户环境只需 Node，不需要安装插件依赖。评估产物写系统临时目录 `om-compaction-eval/`，不写工作区。

## 开发

运行 `pnpm dev` 自动构建，并在 `cordis.patch.yml` 中加载本地 bundle：

```yaml
- insert:
    - id: dsh-plugin-om-dev
      name: file:///<repo>/dist/index.mjs
    - id: dsh-plugin-om-compaction-eval-dev
      name: file:///<repo>/dist/compaction-eval/index.mjs
```

开启热更新时，在同一文件启用 `hmr` 并监听 `dist`。仓库路径含 `.dsh`（如 worktree）时去掉默认忽略的 `**/.*`：

```yaml
- id: hmr
  disabled: false
  config:
    root: ["<repo>/dist"]
    ignored: ["**/node_modules"]
```

热更新说明：

- 改动补丁后无需重启 DSH，运行中的 profile 会重新协调补丁。
- `pnpm dev` 重建 `dist` 后，服务端命令和浏览器端面板都会自动更新，已打开的页面无需刷新。
- 插件行指向新路径时同时改 `id`，确保重新加载新路径的模块。
- 重载不改写会话历史，可能改变后续请求前缀，影响 KV Cache。
- 排查时检查命令首条消息里的评估文档路径，应位于当前仓库的 `dist/skill`。

语义增强首次使用时自动下载嵌入模型，也可运行 `pnpm run download:model` 预下载。

Serena 符号查询需要 uv 和 Python 3.11–3.14。安装依赖时自动准备 Serena，也可运行 `pnpm serena:setup` 手动准备。

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | 监听并构建 |
| `pnpm check` | 检查类型、lint、测试和构建 |
| `pnpm test` | 运行测试 |
| `pnpm serena definition <name_path>` | 寻找符号定义 |
| `pnpm serena references <name_path>` | 寻找符号引用 |
| `pnpm serena doc <name_path>` | 查看符号签名和注释 |
| `pnpm serena:setup` | 准备 Serena Python 依赖 |
| `pnpm run download:model` | 预下载嵌入模型 |
| `pnpm run release` | 检查并发布新版本 |

## 文件地图

```text
cordis.patch.yml                 # bundle patch，按顺序插入包根行与评估组件行
locale/                          # 包根与评估行的中英文展示元信息
src/
├── index.ts                     # 包根入口：注册 recall 工具与 /om-recompress，接线自动压缩和提醒补发
├── system-reminder.ts           # 进度提醒：system-reminder 消息的构造与缺失时补发
├── thinking-binding.ts          # llm/stream 中间件：剥离 OM 压缩前生成的 Claude thinking 签名
├── config.ts                    # 配置默认值与宽松合并，未知键忽略、非法值回退默认
├── constants.ts                 # 共享常量：插件标识、history 与 archived-history 标签、完整消息定义、格式说明注释
├── degrade.ts                   # 挂载失败降级上报：console 外部输出与 om/warning 会话事件
├── om-event.ts                  # om 事件读取：plugin record 的类型名、载荷校验与日志查找
├── om-event-append.ts           # om 事件写入：经 appendPluginRecord 追加 ignorable 记录
├── types.ts                     # type-only：宿主类型再导出与领域类型
├── utils.ts                     # 零依赖工具函数：文本渲染、主会话判定、路由解析
├── json-schema.ts               # zod schema 到工具 wire 参数 JSON Schema 的转换
├── logger.ts                    # 插件日志门面，step 按 debug 开关过滤
├── rate-limit.ts                # 全局 429 限流冷却门，进程级共享状态
├── log-index.ts                 # 完整消息索引与渲染，recall 与压缩共用同一套编号
├── recall.ts                    # recall 工具：按 index 区间回看或按 query 检索
├── recall-xml.ts                # 完整消息到 CDATA 包裹 XML 条目的渲染，recall 与语义检索共用
├── recall-output.ts             # recall 输出契约：{ text, images } 与 render 投影
├── semantic-recall.ts           # recall 检索：本地嵌入语义检索与字符串匹配
├── embedding.ts                 # 本地 ONNX 嵌入：懒加载、批量、运行时按需下载编排
├── model-download.ts            # 模型下载原语：URL、跳过判定、原子落盘
├── compress-view.ts             # 压缩视图：观察与归档投影、归档段切分、skill 提取、有效提问配对与选项展示
├── compress-tools.ts            # 压缩工具状态机：查看、压缩、问答重写、完成门禁与最终块构建
├── compress-loop.ts             # 工具压缩循环：条件提示、多轮请求、工具执行、限流、失败判定与统计
├── compaction-log.ts            # 压缩会话记录落盘：seed 重建系统提示词、时间线与逐轮 usage 的诊断子会话
├── compress.ts                  # 两级自动压缩：观察打标记与到期注入、归档触发与提交、失败传播与生命周期事件
├── reflect.ts                   # 后台归档：进程内任务注册表、尾部保留块选择与失败重试判定
├── precompress.ts               # 后台预压缩：进程内任务注册表、结果信封持久化与重启采纳
├── recompress.ts                # 换模型重压缩：按压缩 id 重放视图并落盘记录，附命令构建
├── recompress-gate.ts           # 重压缩并发信号量：按配置上限排队许可
├── compaction-eval-command.ts   # OM 结果评估命令：定位评估文档、新建同工作区会话并投递首条消息
├── compaction-eval/index.ts     # 评估行入口：注册 /om-compaction-eval
├── eval-session-text.ts         # 评估命令文本契约：命令名与描述、首条消息、成功文本与其反解
└── client/                      # 浏览器客户端 bundle：压缩卡片、包根配置页与评估行门控
    ├── index.ts                 # 注册卡片与渲染器，为包根注册配置页，按评估行启用状态门控模型面板
    ├── om-config-controller.ts  # 包根配置页的字段布局、宿主配置表单、草稿和原子保存
    ├── OmConfigCard.tsx         # 按字段布局渲染的双语配置控件
    ├── definition.ts            # 压缩卡片定义：生命周期事件、检查点替换与警告事件
    ├── OmCompactionCard.tsx     # 压缩结果与错误卡片，可跳转轨迹与诊断子会话
    ├── OmRecompressMenu.tsx     # 重压缩模型多选菜单，复用宿主会话模型目录
    ├── recompress-inject.ts     # 装配模型目录与命令通道
    ├── recompress-run.ts        # 重压缩命令行拼装、组合展开与结果归一化
    ├── eval-model-register.tsx  # 评估命令模型面板：装饰命令并在评估组件行启用时可用
    ├── compaction-eval-jump.ts  # 监听命令执行结果，跳转到评估命令新建的会话
    ├── OmWarningCard.tsx        # 功能降级警告行
    ├── format.ts                # 统计数字紧凑格式化
    └── locales.ts               # 中英文文案
models/                          # 嵌入模型目录
scripts/                         # 下载、发布、skill 打包与 Serena 符号查询脚本
tests/                           # 服务端、客户端与集成测试
web/                             # 机制说明与成本计算器站点
    ├── src/model.ts             # 成本模型
    └── src/components/          # 页面组件与 UI 原语
.agents/skills/agent-workflow/SKILL.md # 仓库开发工作流：worktree 隔离、分步实现与验收
.agents/skills/clear-branch/SKILL.md   # 手动清空除 main 外的分支与 worktree
.agents/skills/compaction-eval/         # 压缩质量盲评打分：视图复现与重压缩、数据准备、分段合并与汇总计分；产物写系统临时目录；构建时渲染为发布版写入 dist/skill
.agents/skills/compaction-tuning/SKILL.md # 压缩质量的长流程评估优化：选样本、诊断、改进点盲测与回归验证；产物写系统临时目录
.agents/skills/real-device-test/        # 实机测试流程：宿主版本对齐、profile 搭建、mock LLM、warm/cold 驱动、CDP 浏览器用例；scripts 为参数化参考实现
.agents/skills/release/SKILL.md        # 手动发布并跟踪 CI 与 npm
.github/workflows/web-deploy.yml # GitHub Pages 部署工作流
```
