# dsh-plugin-om

[![npm version](https://img.shields.io/npm/v/dsh-plugin-om.svg)](https://www.npmjs.com/package/dsh-plugin-om)

在 DSH 里应用 [Observational Memory](https://mastra.ai/research/observational-memory) 风格的上下文管理策略

## 安装与启用

### 说明

- `$DSH_HOME` 缺省为 `~/.dsh`
- *profile*描述了dsh进程的启动模式，官方的启动命令就是名为`web`的profile

### 生产使用

安装插件

```sh
dsh plugin --profile <profile> add dsh-plugin-om
```

> 对于 pnpm11+ 添加脚本失败的说明：
> 插件的依赖 `@huggingface/transformers` 自带原生构建脚本，pnpm 11 默认禁止依赖构建脚本，并会抛出异常。
> 把 `$DSH_HOME/profiles/<profile>/pnpm-workspace.yaml` 的 `allowBuilds` 改为 `true` 即可
> 或者使用`dsh plugin --profile <profile> add dsh-plugin-om --allow-build=onnxruntime-node --allow-build=protobufjs --allow-build=sharp`

安装完成后，需要重启dsh

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

`preset-agent`配置里自带一个`compaction-basic`，会在到达阈值后做简单的摘要，与此插件冲突。

由于配置注入的顺序是层级低的覆盖层级高的，所以`cordis.patch.yml`对`compaction-basic`的禁用不会生效。

此外，这个插件位于`preset-agent`的定义而非额外的安装，也无法通过`dsh plugin`卸载。

解决方案：

- 直接改`preset-agent`的定义(不推荐)
- 定义不含`compaction-basic`的`preset-agent`
- `compaction-basic`压缩阈值是80%上下文窗口，而只需要确保OM的配置中，`thresholdRatio`+`historyMergeRatio`<0.8，理论上没到强制摘要就会被OM压缩了(默认值满足这一条件)

## 工作原理

1. 在未压缩的消息到达观察阈值后，进行摘要
2. 将新生成摘要追加到已有摘要后
3. 如果摘要总长到达反思阈值，对其本身进行摘要
4. 提供recall/recall-semantic两个tool进行检索

### 注意

- recall 不截断，建议保留 `tool-result-pruner`
- recall-semantic 使用本地多语言嵌入模型（paraphrase-multilingual-MiniLM-L12-v2），

### 依赖策略

- 复用dsh宿主提供的依赖，如 cordis / dsh-tools / zod 等
- 例外：recall-semantic 的本地嵌入需要运行时依赖 `@huggingface/transformers`（transformers.js v4 + onnxruntime-node），模型小文件（config/tokenizer 等）随 npm 包分发（`models/`），onnx 二进制不随包分发（见下）
- 模型二进制：量化 ONNX 约 113MB，超过 GitHub 单文件 100MB 限制，**不进入 git 仓库，也不随 npm 包分发**（`package.json` 的 `files` 以 `!models/*/onnx/*.onnx` 排除，见 `tests/package-pack.test.ts`）。改为**运行时按需下载**：仅当配置键 `semanticRecallEnabled` 启用且 `models/<id>/onnx/model_quantized.onnx` 缺失时，插件 apply 后台自动从 HuggingFace（[Xenova 转换仓库](https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2)）下载到 `models/`（不阻塞；下载失败仅记日志，下次调用自动重试；未就绪时 `recall-semantic` 工具返回文案告知模型）；本地开发也可用 `pnpm run download:model` 手动预下载（已存在则跳过，`--force` 强制重下）；直连 `huggingface.co` 受限时设置环境变量 `HF_ENDPOINT=https://hf-mirror.com` 走镜像

## 插件配置项

| 键                      | 默认     | 含义                                                                                                                                                                         |
| ----------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `thresholdRatio`        | `0.5`    | 观察阈值：未压缩消息 ≥ 窗口 × 该比例触发压缩                                                                                                                                 |
| `historyMergeRatio`     | `0.2`    | 反思阈值：摘要 ≥ 窗口 × 该比例触发精简合并                                                                                                                                   |
| `compressMaxTokens`     | `4096`   | 单次摘要（观察/反思调用）生成上限                                                                                                                                            |
| `tailMessageCount`      | `10`     | 尾部保留的不压缩消息条数（不压缩、不被替换、不进摘要日志）                                                                                                                   |
| `modelDir`              | 打包模型 | recall-semantic 嵌入模型目录（默认插件内 `models/` 目录，仅小文件随包分发；可指向自定义目录）。onnx 缺失且启用语义召回时运行时自动下载到该目录                               |
| `summaryMode`           | `fork`   | 摘要模式：`fork`（缺省）/ `new` / `disable`（关闭自动压缩）；非法值在插件加载时报错（见[摘要模式](#摘要模式)）                                                               |
| `debug`                 | dev      | 压缩流程步骤级（debug）日志开关：`true` 强制开启、`false` 强制关闭；缺省按 `NODE_ENV !== 'production'` 判定（dev/test 输出，生产隐藏）。**失败日志不受此开关影响，始终输出** |
| `recallEnabled`         | `true`   | 是否注册 `recall` 工具（`false` 时禁用，不注册）                                                                                                                             |
| `semanticRecallEnabled` | `true`   | 是否注册 `recall-semantic` 工具（`false` 时禁用，不注册、不触发模型下载）                                                                                                    |

### 摘要模式

摘要调用由配置键 `summaryMode` 控制：

- `fork`：从需要压缩的位置fork会话，复用前缀缓存，要求摘要
- `new`：开启一个新会话，输入需要压缩的会话，要求摘要
- `disable`：关闭OM。recall/recall-semantic 按「完整消息 index」检索（index 从 0 起、会话内全局稳定，模型可感知并可与摘要日志条目互相对应）

## npm 命令

| 命令                        | 作用                                                                              |
| --------------------------- | --------------------------------------------------------------------------------- |
| `pnpm check`                | typecheck + lint + test + build                                                   |
| `pnpm typecheck`            | TypeScript 类型检查                                                               |
| `pnpm lint` / `pnpm format` | 代码检查 / 格式化                                                                 |
| `pnpm test`                 | vitest 单元测试                                                                   |
| `pnpm run download:model`   | 手动预下载本地嵌入模型 ONNX（已存在跳过，`--force` 重下；运行时也会按需自动下载） |
| `pnpm build`                |                                                                                   |
| `pnpm dev`                  | 自动打包                                                                          |
| `pnpm run release`          | 先跑 check（typecheck+lint+test+build），再 CHANGELOG 归档 + 版本号更新 + 打 tag 推送      |

## 调用链和文件地图

```
cordis.patch.yml              # bundle patch：dsh plugin add 后作为组合层插入插件行（id = dsh-plugin-om）
src/
├── index.ts                   # 打包入口（tsdown entry），导出 name / inject / apply
│   apply(ctx, config) 三条主线（标注对应实现文件）：
│   ├─ ① resolveConfig(config) ──▶ config.ts        # 配置默认值合并 + 逐键校验（留空回退默认，冻结返回）
│   ├─ ② recallEnabled 时 ctx.tools.register(buildRecallTool(() => ctx.get('toolResultPruner')))
│   │      └─▶ recall.ts                            # recall 工具：按完整消息 index 回看区间（超大结果由 pruner 裁剪）
│   ├─ ③ semanticRecallEnabled 时 ctx.tools.register(buildSemanticRecallTool({ getPruner, modelStatus, embedder }))
│   │      └─▶ semantic-recall.ts                   # recall-semantic 工具：本地嵌入按语义检索全部完整消息（含被压缩/遮蔽；区间越界回退全量）
│   │           └─▶ embedding.ts                    # 本地 ONNX 嵌入：ensureModelReady 运行时按需下载（不阻塞/单飞）+ 懒加载 + 批量 embed + cosine
│   │                └─▶ model-download.ts          # 模型下载原语（URL/跳过判定/原子落盘；dev CLI 复用）
│   └─ ④ 事件接线（仅主会话生效）
│        └─ ctx.on('agent/pre-step') → compress.ts  # maybeCompress：两级压缩阻塞串行（先反思后观察；turn 中间即可触发）
│              ├─ reflectPass → summarize.ts        # 摘要 ≥ 窗口 × historyMergeRatio：摘要调用精简合并 <om-history>
│              ├─ observePass  → summarize.ts       # 未压缩消息 ≥ 窗口 × thresholdRatio：摘要调用观察日志 → 追加 + 替换
│              └─ 提交          → compress.ts        # compaction/start → summary → 替换消息(checkpoint) → end；usage 归入主会话
├── constants.ts              # 共享常量（PLUGIN_LABEL / HISTORY_TAG / COMPACT_CHECKPOINT_PLUGIN）
├── types.ts                  # type-only：宿主类型再导出 + 领域类型（MessageNode / MessageIndex）
├── config.ts                 # 配置默认值 / 校验（缺省、null、空串回退默认值；数值键/布尔键/summaryMode/modelDir）
├── utils.ts                  # 零依赖工具函数（配置校验 / 文本渲染 / 主会话判定 / 路由解析）
├── log-index.ts              # 完整消息索引（index 定位 user/assistant/toolcall 三类完整消息；recall 与摘要共用）
├── embedding.ts              # 本地 ONNX 嵌入（@huggingface/transformers + 本地模型；运行时按需下载编排 / 懒加载 / 批量 / cosine）
├── model-download.ts          # 模型下载原语（modelSourceUrl / needsDownload / 原子落盘；运行时与 dev CLI 共用）
├── summarize.ts              # 观察/反思 persona + 提示词 + 直连 ctx.llm.stream() 摘要（fork/new 双模式；extractSummaryLog 提取校验；流式 usage 归入主会话）
├── recall.ts                 # recall 工具
├── semantic-recall.ts        # recall-semantic 工具（query 语义检索 + 区间限定 + 回退全量 + 匹配说明）
└── compress.ts               # 两级自动压缩（测量 / mid-turn 区间计算 / 配对平衡回退 / source 标记判定摘要消息 / compaction/* 生命周期事件 + checkpoint 替换）
models/
└── paraphrase-multilingual-MiniLM-L12-v2/   # 嵌入模型目录（小文件随包分发；onnx 二进制不随包分发、由运行时按需下载到此处，不进 git）
scripts/                      # release-archive.mjs（CHANGELOG 归档）/ download-model.mjs（开发手动预下载 CLI）
tests/                        # vitest 单元测试（140 例）
.dsh/skills/                  # 项目级 skill（feature-defect-workflow：需求/缺陷完成工作流）
```

## TODO
