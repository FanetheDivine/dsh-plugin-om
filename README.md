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

运行`pnpm dev`，等待`dist/index.mjs`构筑完毕（本地嵌入模型可在运行时自动下载到跨版本共享目录；如需提前预下载用`pnpm run download:model`，已存在则跳过）

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
2. 将新生成摘要追加到已有摘要后（每条压缩日志是独立的消息/块，旧块原地保留）
3. 如果摘要总长到达反思阈值，对其本身进行摘要（把全部 <history> 块拼接合并为一条）
4. 提供recall/recall-semantic两个tool进行检索

观察与反思共用同一套系统提示词（buildHistoryPrompt）：输入与输出都是合法的 <history> 块（模型消息 + index 的表达形式），先定义块、要求压缩、再给出数据源（下方 <history> 消息记录）。

### 压缩日志块结构

- 观察压缩只精确替换被压缩的新消息区间：旧 <history> 块保留为独立消息，新观察日志作为新块追加在其后（多块并存按序排列），历史不会随压缩次数膨胀；反思合并时才把多个块合并为一条更紧凑的摘要
- 压缩边界：消息列表中最后一个合法的 <history> 块（source 为插件，plugin 为插件标识 `dsh-plugin-om`；兼容旧日志的宿主 checkpoint 标记 `compact`）之后的消息视为未压缩；其前（含自身）视为已压缩，不重复压缩、不计入观察阈值
- 观察输入经 `@xmldom/xmldom` 构建为合法 <history> 块（用户消息文本/assistant 文本/reasoning 特殊字符自动转义，图片/文件以注释补充；assistant 文本与 toolcall&result 原样）
- 输出经 `@xmldom/xmldom` 解析校验：结构合法（标签匹配/闭合/单块）、不含 <reasoning>、index/start/end 连续（与预期覆盖区间一致），失败按 `compressRetryCount` 重试
- 块开标签带 `tip` 属性（对 AI 的提醒："当前块是历史消息的压缩产物，不要复述"）；块顶为构成逻辑注释（完整消息定义串 + 条目标签语义），消息正文不再附加前缀句

### 注意

- recall 不截断，建议保留 `tool-result-pruner`
- recall-semantic 使用本地多语言嵌入模型（paraphrase-multilingual-MiniLM-L12-v2），

### 依赖策略

- dsh宿主提供的依赖，直接复用即可，如 cordis / dsh-tools / zod 等
- `@xmldom/xmldom` 用于 <history> 块的 XML 构建（输入转义）与解析校验（输出结构合法性），经 tsdown `deps.alwaysBundle` 打包进 dist 产物
- 向量模型模型二进制：量化 ONNX 约 113MB，启用语义召回时下载，位置`$DSH_HOME/plugin-data/dsh-plugin-om/models/<id>/onnx/model_quantized.onnx`。下载失败可以设置`HF_ENDPOINT=https://hf-mirror.com`

## 插件配置项

| 键                      | 默认     | 含义                                                                                                                                                                         |
| ----------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `thresholdRatio`        | `0.1`    | 观察阈值：未压缩消息 ≥ 窗口 × 该比例触发压缩                                                                                                                                 |
| `historyMergeRatio`     | `0.2`    | 反思阈值：全部 <history> 块总长 ≥ 窗口 × 该比例触发精简合并                                                                                                                                   |
| `compressMaxTokens`     | `10000`  | 单次摘要（观察/反思调用）生成上限                                                                                                                                            |
| `tailMessageCount`      | `10`     | 尾部保留的不压缩消息条数（不压缩、不被替换、不进摘要日志）                                                                                                                   |
| `compressRetryCount`    | `10`     | 摘要调用失败后的最大重试次数（不含首次；总尝试次数 = 该值 + 1）                                                                                                              |
| `modelDir`              | 共享目录 | recall-semantic 嵌入模型目录（默认 `$DSH_HOME/plugin-data/dsh-plugin-om/models/<id>`，跨插件版本共享；小文件随包分发并在缺失时自动补齐，onnx 缺失且启用语义召回时运行时自动下载到该目录；可指向自定义目录） |
| `omEnabled`            | `true`   | 是否启用 OM 自动压缩（观察/反思）；`false` 时关闭自动压缩，recall/recall-semantic 不受影响。`omEnabled` 替代原 `summaryMode`（见[摘要方式](#摘要方式)）                    |
| `debug`                 | dev      | 压缩流程步骤级（debug）日志开关：`true` 强制开启、`false` 强制关闭；缺省按 `NODE_ENV !== 'production'` 判定（dev/test 输出，生产隐藏）。**失败日志不受此开关影响，始终输出** |
| `recallEnabled`         | `true`   | 是否注册 `recall` 工具（`false` 时禁用，不注册）                                                                                                                             |
| `semanticRecallEnabled` | `true`   | 是否注册 `recall-semantic` 工具（`false` 时禁用，不注册、不触发模型下载）                                                                                                    |

> 不建议将thresholdRatio设置的过高，越早OM收益越高，且当前的机制需要模型对消息计数，过多的消息会导致历史混乱

### 关于配置项变更的说明

配置键 `omEnabled` 替代了原 `summaryMode`：现在只能通过 `omEnabled` 开启或关闭 OM。

现在消息调用会固定新开会话，而取消了fork主会话的链路。fork 方式虽然能复用前缀缓存，但需要模型自行对消息计数，会导致严重的索引异常。

## npm 命令

| 命令                        | 作用                                                                              |
| --------------------------- | --------------------------------------------------------------------------------- |
| `pnpm check`                | typecheck + lint + test + build                                                   |
| `pnpm typecheck`            | TypeScript 类型检查                                                               |
| `pnpm lint` / `pnpm format` | 代码检查 / 格式化                                                                 |
| `pnpm test`                 | vitest 单元测试                                                                   |
| `pnpm run download:model`   | 手动预下载本地嵌入模型 ONNX 到共享目录（默认 `$DSH_HOME/plugin-data/dsh-plugin-om/models/<id>`；已存在跳过，`--force` 重下；运行时也会按需自动下载） |
| `pnpm build`                |                                                                                   |
| `pnpm dev`                  | 自动打包                                                                          |
| `pnpm run release`          | 先跑 check（typecheck+lint+test+build），再 CHANGELOG 归档 + 版本号更新 + 打 tag 推送      |

## 调用链和文件地图

```
cordis.patch.yml              # bundle patch：dsh plugin add 后作为组合层插入插件行（id = dsh-plugin-om）
src/
├── index.ts                   # 打包入口（tsdown entry），导出 name / inject / apply
│   apply(ctx, config) 三条主线（标注对应实现文件）：
│   ├─ ① resolveConfig(config) ──▶ config.ts        # 配置默认值合并 + 宽松校验（未知键忽略、非法值回退默认，冻结返回）
│   ├─ ② recallEnabled 时 ctx.tools.register(buildRecallTool(() => ctx.get('toolResultPruner')))
│   │      └─▶ recall.ts                            # recall 工具：按完整消息 index 回看区间（超大结果由 pruner 裁剪）
│   ├─ ③ semanticRecallEnabled 时 ctx.tools.register(buildSemanticRecallTool({ getPruner, modelStatus, embedder }))
│   │      └─▶ semantic-recall.ts                   # recall-semantic 工具：本地嵌入按语义检索全部完整消息（含被压缩/遮蔽；区间越界回退全量）
│   │           └─▶ embedding.ts                    # 本地 ONNX 嵌入：ensureModelReady 运行时按需下载（不阻塞/单飞）+ 懒加载 + 批量 embed + cosine
│   │                └─▶ model-download.ts          # 模型下载原语（URL/跳过判定/原子落盘；dev CLI 复用）
│   └─ ④ 事件接线（仅主会话生效）
│        └─ ctx.on('agent/pre-step') → compress.ts  # maybeCompress：两级压缩阻塞串行（先反思后观察；turn 中间即可触发）
│              ├─ reflectPass → summarize.ts        # 全部 <history> 块总长 ≥ 窗口 × historyMergeRatio：多块拼接 + 共享提示词合并整个块区段
│              ├─ observePass  → summarize.ts       # 未压缩消息 ≥ 窗口 × thresholdRatio：渲染 <history> 输入 → 观察日志 → 追加 + 替换
│              └─ 提交          → compress.ts        # compaction/start → summary → 替换消息(source 插件标识 + compactionId) → end；usage 归入主会话
├── constants.ts              # 共享常量（PLUGIN_LABEL / HISTORY_TAG / HISTORY_TIP / COMPLETE_MESSAGE_DEFINITION / COMPACT_CHECKPOINT_PLUGIN）
├── types.ts                  # type-only：宿主类型再导出 + 领域类型（MessageNode / MessageIndex）
├── config.ts                 # 配置默认值 / 宽松合并（缺省、null、空串回退默认值；未知键忽略、非法值回退默认；数值键/布尔键/omEnabled/modelDir）
├── utils.ts                  # 零依赖工具函数（配置校验 / 文本渲染 / 主会话判定 / 路由解析）
├── log-index.ts              # 完整消息索引（index 定位 user/assistant/具有result的toolcall；未闭合 tool-call 不占位；recall 与摘要共用）
├── embedding.ts              # 本地 ONNX 嵌入（@huggingface/transformers + 本地模型；共享目录解析 / 小文件补齐 / 运行时按需下载编排 / 懒加载 / 批量 / cosine）
├── model-download.ts          # 模型下载原语（modelSourceUrl / needsDownload / 原子落盘 / 开始结束日志与失败镜像建议；运行时与 dev CLI 共用）
├── summarize.ts              # 共享提示词 buildHistoryPrompt（观察/反思同一套）+ renderMessages（@xmldom/xmldom 构建 <history> 块输入，自动转义）+ 直连 ctx.llm.stream() 摘要（new 方式：指令作 system、输入为渲染消息；extractSummaryLog 提取校验：XML 结构合法 / 无 reasoning / index 连续 / 覆盖区间；重试与流式 usage 归入主会话）
├── recall.ts                 # recall 工具
├── semantic-recall.ts        # recall-semantic 工具（query 语义检索 + 区间限定 + 回退全量 + 匹配说明）
└── compress.ts               # 两级自动压缩（测量 / mid-turn 区间计算 / 配对平衡回退 / source 标记判定摘要消息 / compaction/* 生命周期事件 + 替换消息 source 插件标识）
models/
└── paraphrase-multilingual-MiniLM-L12-v2/   # 嵌入模型目录（小文件随包分发；onnx 二进制不随包分发、由运行时按需下载到跨版本共享目录，不进 git）
scripts/                      # release-archive.mjs（CHANGELOG 归档）/ download-model.mjs（开发手动预下载 CLI）
tests/                        # vitest 单元测试（151 例）
.dsh/skills/                  # 项目级 skill（feature-defect-workflow：需求/缺陷完成工作流）
```

## TODO
