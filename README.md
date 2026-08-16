# dsh-plugin-om

[![npm version](https://img.shields.io/npm/v/dsh-plugin-om.svg)](https://www.npmjs.com/package/dsh-plugin-om)

在 DSH 里应用 [Observational Memory](https://mastra.ai/research/observational-memory) 风格的上下文管理策略

## 工作原理

1. 在未压缩消息超过阈值后摘要：压缩**尾部之前**的消息并用摘要替换（尾部 `tailMessageCount` 条不压缩、不被替换、不进日志）
2. 摘要替换原始消息，并以**多个 `<om-history>` 块按序拼接**的方式追加至现有摘要（旧块原样保留，新块追加在末尾）
3. 摘要超过阈值后重新摘要（反思：精简合并现有日志块）
4. 摘要输出为**合法 XML 日志**（`<om-history>` 内 `<user_message id>` 完整保留用户原文、`<assistant last_id>` 聚合 AI 模块）；插件不信任 AI 输出，取首个 `<om-history>` 到最后一个 `</om-history>`（含首尾）切为日志，找不到或中间内容过短视为不合法并按失败重试；产出后插入格式说明注释
5. 摘要过程中保留 message_id（`<user_message id>` / `<assistant last_id>`），允许模型精确 recall
6. 压缩在 `agent/pre-step` 触发（**turn 中间即可**，无需等待轮次结束）：摘要直连 LLM，模式见[摘要模式](#摘要模式环境变量)——`fork`（缺省）复用主会话请求前缀（系统提示词 + 完整消息 + 末尾指令），充分利用 provider 前缀缓存；`new` 只注入被压缩消息（XML 包裹）；`disable` 关闭自动压缩
7. 提供语义召回（recall-semantic）：按自然语言在全部消息日志中检索，被压缩/遮蔽的消息也可按语义找回

### 注意

- recall 不截断，建议保留 `tool-result-pruner`
- 默认上下文压缩插件 `compaction-basic` 到达阈值后会自动摘要，不建议和此插件一起使用
- recall-semantic 使用本地多语言嵌入模型（paraphrase-multilingual-MiniLM-L12-v2，量化 ONNX），完全离线；首次调用时加载模型，之后复用。模型二进制（~113MB）不进入 git 仓库，改为**运行时按需下载**：启用 recall-semantic 且模型缺失时，插件启动即后台自动下载（不阻塞），未就绪时工具会告知模型（见[依赖策略](#依赖策略)）

### 依赖策略

- 以type-only的方式引用第三方库（编译期类型，运行时零依赖）
- 复用dsh宿主提供的依赖，如 cordis / dsh-tools / zod 等
- 例外：recall-semantic 的本地嵌入需要运行时依赖 `@huggingface/transformers`（transformers.js v4 + onnxruntime-node），模型小文件（config/tokenizer 等）随 npm 包分发（`models/`），onnx 二进制不做构建/发布时下载
- 模型二进制：量化 ONNX 约 113MB，超过 GitHub 单文件 100MB 限制，**不进入 git 仓库**。改为**运行时按需下载**：仅当 `OM_SEMANTIC_RECALL_ENABLED` 启用且 `models/<id>/onnx/model_quantized.onnx` 缺失时，插件 apply 后台自动从 HuggingFace（[Xenova 转换仓库](https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2)）下载到 `models/`（不阻塞；下载失败仅记日志，下次调用自动重试；未就绪时 `recall-semantic` 工具返回文案告知模型）；本地开发也可用 `pnpm run download:model` 手动预下载（已存在则跳过，`--force` 强制重下）；直连 `huggingface.co` 受限时设置环境变量 `HF_ENDPOINT=https://hf-mirror.com` 走镜像

## 安装与启用

### 说明

- `$DSH_HOME` 缺省为 `~/.dsh`
- *profile*描述了dsh进程的启动模式，官方的启动命令就是名为`web`的profile

### 生产使用

安装插件

```sh
dsh plugin --profile <profile> add dsh-plugin-om
```

需要重启dsh

可以通过`dsh --profile <profile> --dump-config`审查配置是否正确

如果需要覆盖默认配置，打开 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 删除里面的空数组，加入

```yaml
- id: dsh-plugin-om
  config:
    thresholdRatio: 0.2
    # 其他配置参考下文
```

不需要重启 可以热更新

### 开发插件

运行`pnpm dev`，等待`dist/index.mjs`构筑完毕（本地嵌入模型可在运行时自动下载；如需提前预下载用`pnpm run download:model`，已存在则跳过）

在 `cordis.patch.yml` 里加入

```yaml
- insert:
    - id: dsh-plugin-om-dev
      name: file:///<repo>/dist/index.mjs
```

可以热重载

### 关于`compaction-basic`

dsh的"预设"分为两层，`dsh web`等同于`dsh --profile web`，调用的是"名为web的profile"，进程上的预设

而`web-profile`里定义了多个"预设agent"`preset-agent` 这里主要说的是`preset-agent`的问题

`preset-agent`配置里自带一个`compaction-basic`。由于配置注入的顺序是层级低的覆盖层级高的，所以`cordis.patch.yml`对`compaction-basic`的禁用不会生效。

此外，这个插件位于`preset-agent`的定义而非额外的安装，也无法通过`dsh plugin`卸载。

解决方案：

- 直接改`preset-agent`的定义(不推荐)
- 定义不含`compaction-basic`的`preset-agent`
- `compaction-basic`压缩阈值是80%上下文窗口，而只需要确保OM的配置中，`thresholdRatio`+`historyMergeRatio`<0.8，理论上没到强制摘要就会被OM压缩了(默认值满足这一条件)

## 插件配置项

| 键                  | 默认     | 含义                                                                       |
| ------------------- | -------- | -------------------------------------------------------------------------- |
| `thresholdRatio`    | `0.5`    | 观察阈值：未压缩消息 ≥ 窗口 × 该比例触发压缩                               |
| `historyMergeRatio` | `0.2`    | 反思阈值：摘要 ≥ 窗口 × 该比例触发精简合并                                 |
| `compressMaxTokens` | `4096`   | 单次摘要（观察/反思调用）生成上限                                          |
| `tailMessageCount`  | `10`     | 尾部保留的不压缩消息条数（不压缩、不被替换、不进摘要日志）                 |
| `modelDir`          | 打包模型 | recall-semantic 嵌入模型目录（默认插件内打包的本地模型；可指向自定义目录）。onnx 缺失时运行时自动下载到该目录 |

> 数值键（`thresholdRatio` / `historyMergeRatio` / `compressMaxTokens` / `tailMessageCount`）**不做取值区间限制**（如阈值不再限定 0.01–1）：用户提供的值按原样接受（仅校验为有限数，整数键另校验整数性），便于调试时设置任意值。

### 摘要模式（环境变量）

摘要调用由环境变量 `DSH_OM_SUMMARY_MODE` 控制（缺省 `fork`；非法值在插件加载时报错；旧值 `prefix` / `system` 仍兼容，分别视为 `fork` / `new`）：

- `fork`（缺省）：fork 会话风格——复用主会话请求前缀——`system`/`tools` 取自主会话上次请求，`messages` = 完整派生历史 + 末尾追加指令 user 消息，本次摘要请求是主会话请求的**真前缀**，充分利用 provider 前缀缓存（与宿主 `compaction-basic` 同款策略）。
- `new`：新开会话风格——指令（persona + 规则）作为 system 提示词，只注入本次要压缩的消息作为 user 消息输入模型压缩（不注入旧压缩日志、不注入尾部）。
- `disable`：关闭自动压缩（观察/反思均不触发；recall 工具仍由 `OM_RECALL_ENABLED` / `OM_SEMANTIC_RECALL_ENABLED` 独立控制）。

## 环境变量

| 变量                         | 默认 | 含义                                                     |
| ---------------------------- | ---- | -------------------------------------------------------- |
| `OM_RECALL_ENABLED`          | 启用 | 是否注册 `recall` 工具（值恰为 `false` 时禁用）          |
| `OM_SEMANTIC_RECALL_ENABLED` | 启用 | 是否注册 `recall-semantic` 工具（值恰为 `false` 时禁用；启用且模型缺失时才触发后台模型下载） |
| `DSH_OM_DEBUG`               | dev  | 压缩流程步骤级（debug）日志开关：值恰为 `true` 强制开启、`false` 强制关闭；缺省按 `NODE_ENV !== 'production'` 判定（dev/test 输出，生产隐藏）。**失败日志不受此开关影响，始终输出** |

取值规则：`OM_RECALL_ENABLED` / `OM_SEMANTIC_RECALL_ENABLED` 值**恰为** `false` 时禁用对应工具（不注册；`recall-semantic` 禁用时嵌入模型不会加载、也不会触发模型下载），其余取值（含未设置 / 空串 / `true` / `1` 等）均启用。两个开关相互独立，只影响工具注册，不影响压缩接线。

示例（禁用 recall-semantic，保留 recall；生产环境强制输出步骤日志）：

```sh
OM_SEMANTIC_RECALL_ENABLED=false dsh web
DSH_OM_DEBUG=true dsh web
```

### 日志与摘要重试

- 压缩流程（路由 / 模型容量 / 阈值判定 / 区间计算 / 摘要调用 / 提交各步）逐步输出步骤级日志（`debug` 级，dev 环境默认可见，见 `DSH_OM_DEBUG`）。
- 摘要调用失败（抛异常 / 空输出 / 非 `stop` 结束）均记录日志并**自动重试，总共最多尝试 3 次**；每次失败记录尝试次数与原因，重试耗尽后记录最终失败日志。失败日志不受 dev 开关影响，始终输出。

## recall 工具

| 参数       | 必填   | 含义                                      |
| ---------- | ------ | ----------------------------------------- |
| `start_id` | 是     | message_id(uuid)，区间的基准边界          |
| `end_id`   | 二选一 | message_id(uuid)，指定区间的另一个边界    |
| `offset`   | 二选一 | 相对 start_id 的消息步数（正向后/负向前） |

按 message_id 回看指定区间的原始消息（含代码与工具结果），超大结果由 `tool-result-pruner` 裁剪。

## recall-semantic 工具

| 参数       | 必填 | 含义                                                      |
| ---------- | ---- | --------------------------------------------------------- |
| `query`    | 是   | 自然语言描述要找的内容（可混用中英文与代码术语）          |
| `top_k`    | 否   | 返回最匹配的消息条数（1-10，默认 3）                      |
| `start_id` | 否   | 限定检索区间的基准边界（意义同 recall）；缺省检索全部消息 |
| `end_id`   | 否   | 限定区间的另一个边界（与 offset 互斥，意义同 recall）     |
| `offset`   | 否   | 相对 start_id 的步数（与 end_id 互斥，意义同 recall）     |

按语义（自然语言含义）在**全部消息日志**（含被压缩/遮蔽的 user/assistant/tool-result 事件）中检索，返回最匹配的若干条**完整消息**（message_id / seq / 类型 + 相似度 + 命中关键词）。区间参数限定检索范围；区间不合法（如 id 不存在）不报错，回退全量检索并在结果中明确告知模型。首次启用时嵌入模型可能正在后台下载：未就绪时工具返回提示文案告知模型（不报错、不阻塞等待），下载完成后直接再次调用即可。仅主会话可用；超大结果由 `tool-result-pruner` 裁剪。

## npm 命令

| 命令                        | 作用                                                |
| --------------------------- | --------------------------------------------------- |
| `pnpm check`                | typecheck + lint + test + build                     |
| `pnpm typecheck`            | TypeScript 类型检查                                 |
| `pnpm lint` / `pnpm format` | 代码检查 / 格式化                                   |
| `pnpm test`                 | vitest 单元测试                                     |
| `pnpm run download:model`   | 手动预下载本地嵌入模型 ONNX（已存在跳过，`--force` 重下；运行时也会按需自动下载） |
| `pnpm build`                |                                                     |
| `pnpm dev`                  | 自动打包                                            |
| `pnpm run release`          | CHANGELOG 归档 + 版本号更新 + 打 tag 推送           |

## 调用链和文件地图

```
cordis.patch.yml              # bundle patch：dsh plugin add 后作为组合层插入插件行（id = dsh-plugin-om）
src/
├── index.ts                   # 打包入口（tsdown entry），导出 name / inject / apply
│   apply(ctx, config) 三条主线（标注对应实现文件）：
│   ├─ ① resolveConfig(config) ──▶ config.ts        # 配置默认值合并 + 逐键校验（留空回退默认，冻结返回）
│   ├─ ② ctx.tools.register(buildRecallTool(() => ctx.get('toolResultPruner')))
│   │      └─▶ recall.ts                            # recall 工具：按 message_id 回看区间（超大结果由 pruner 裁剪）
│   ├─ ③ ctx.tools.register(buildSemanticRecallTool({ getPruner, modelStatus, embedder }))
│   │      └─▶ semantic-recall.ts                   # recall-semantic 工具：本地嵌入按语义检索全部消息日志（含被压缩/遮蔽）
│   │           └─▶ embedding.ts                    # 本地 ONNX 嵌入：ensureModelReady 运行时按需下载（不阻塞/单飞）+ 懒加载 + 批量 embed + cosine
│   │                └─▶ model-download.ts          # 模型下载原语（URL/跳过判定/原子落盘；dev CLI 复用）
│   └─ ④ 事件接线（仅主会话生效）
│        └─ ctx.on('agent/pre-step') → compress.ts  # maybeCompress：两级压缩阻塞串行（先反思后观察；turn 中间即可触发）
│              ├─ reflectPass → summarize.ts        # 摘要 ≥ 窗口 × historyMergeRatio：摘要调用精简合并 <om-history>
│              ├─ observePass  → summarize.ts       # 未压缩消息 ≥ 窗口 × thresholdRatio：摘要调用观察日志 → 追加 + 替换
│              └─ 提交          → compress.ts        # compaction/start → summary → 替换消息(checkpoint) → end；usage 归入主会话
├── constants.ts              # 共享常量（PLUGIN_LABEL / HISTORY_TAG / COMPACT_CHECKPOINT_PLUGIN）
├── types.ts                  # type-only：宿主类型再导出 + 领域类型（MessageNode / MessageIndex）
├── config.ts                 # 配置默认值 / 校验（缺省、null、空串回退默认值；含 modelDir）
├── utils.ts                  # 零依赖工具函数（配置校验 / 文本渲染 / 主会话判定 / 路由解析）
├── log-index.ts              # 消息索引（message_id → 消息事件；recall 消费）
├── embedding.ts              # 本地 ONNX 嵌入（@huggingface/transformers + 本地模型；运行时按需下载编排 / 懒加载 / 批量 / cosine）
├── model-download.ts          # 模型下载原语（modelSourceUrl / needsDownload / 原子落盘；运行时与 dev CLI 共用）
├── summarize.ts              # 观察/反思 persona + 提示词 + 直连 ctx.llm.stream() 摘要（fork/new 双模式；extractSummaryLog 提取校验；流式 usage 归入主会话）
├── recall.ts                 # recall 工具
├── semantic-recall.ts        # recall-semantic 工具（query 语义检索 + 区间限定 + 回退全量 + 匹配说明）
└── compress.ts               # 两级自动压缩（测量 / mid-turn 区间计算 / 配对平衡回退 / 中断扫描 / 对照表 / source 标记判定摘要消息 / compaction/* 生命周期事件 + checkpoint 替换）
models/
└── paraphrase-multilingual-MiniLM-L12-v2/   # 嵌入模型目录（小文件随包分发；onnx 二进制由运行时按需下载到此处，不进 git）
scripts/                      # release-archive.mjs（CHANGELOG 归档）/ download-model.mjs（开发手动预下载 CLI）
tests/                        # vitest 单元测试（136 例）
.dsh/skills/                  # 项目级 skill（feature-defect-workflow：需求/缺陷完成工作流）
```

## 开发计划

- 将OM和recall分为两个包
