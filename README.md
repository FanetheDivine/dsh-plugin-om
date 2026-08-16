# dsh-plugin-om

[![npm version](https://img.shields.io/npm/v/dsh-plugin-om.svg)](https://www.npmjs.com/package/dsh-plugin-om)

在 DSH 里应用 [Observational Memory](https://mastra.ai/research/observational-memory) 风格的上下文管理策略

## 工作原理

1. 在未压缩消息超过阈值后摘要
2. 摘要会替换原始消息，并追加至现有摘要
3. 在摘要超过阈值后，重新摘要
4. 摘要过程中保留关键的message_id，允许模型精确recall

### 注意

- recall 不截断，建议保留 `tool-result-pruner`
- 默认上下文压缩插件 `compaction-basic` 到达阈值后会自动摘要，不建议和此插件一起使用

### 依赖策略

- 以type-only的方式引用第三方库
- 复用dsh宿主提供的依赖，如 cordis / dsh-tools / zod 等

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

运行`pnpm dev`，等待`dist/index.mjs`构筑完毕

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

| 键                  | 默认   | 含义                                         |
| ------------------- | ------ | -------------------------------------------- |
| `thresholdRatio`    | `0.5`  | 观察阈值：未压缩消息 ≥ 窗口 × 该比例触发压缩 |
| `historyMergeRatio` | `0.2`  | 反思阈值：摘要 ≥ 窗口 × 该比例触发精简合并   |
| `compressMaxTokens` | `4096` | 单次摘要（观察/反思调用）生成上限            |
| `tailMessageCount`  | `10`   | 压缩后保留的未压缩消息条数                   |

## npm 命令

| 命令                        | 作用                                      |
| --------------------------- | ----------------------------------------- |
| `pnpm check`                | typecheck + lint + test + build           |
| `pnpm typecheck`            | TypeScript 类型检查                       |
| `pnpm lint` / `pnpm format` | 代码检查 / 格式化                         |
| `pnpm test`                 | vitest 单元测试                           |
| `pnpm build`                |                                           |
| `pnpm dev`                  | 自动打包                                  |
| `pnpm run release`          | CHANGELOG 归档 + 版本号更新 + 打 tag 推送 |

## 调用链和文件地图

```
cordis.patch.yml              # bundle patch：dsh plugin add 后作为组合层插入插件行（id = dsh-plugin-om）
src/
├── index.ts                   # 打包入口（tsdown entry），导出 name / inject / apply
│   apply(ctx, config) 三条主线（标注对应实现文件）：
│   ├─ ① resolveConfig(config) ──▶ config.ts        # 配置默认值合并 + 逐键校验（留空回退默认，冻结返回）
│   ├─ ② ctx.tools.register(buildRecallTool(() => ctx.get('toolResultPruner')))
│   │      └─▶ recall.ts                            # recall 工具：按 message_id 回看区间（超大结果由 pruner 裁剪）
│   └─ ③ 事件接线（仅主会话生效）
│        └─ ctx.on('agent/pre-step') → compress.ts  # maybeCompress：两级压缩阻塞串行（先反思后观察）
│              ├─ reflectPass → summarize.ts        # 摘要 ≥ 窗口 × historyMergeRatio：fork 精简合并 <om-history>
│              ├─ observePass  → summarize.ts       # 未压缩消息 ≥ 窗口 × thresholdRatio：fork 观察日志 → 追加 + 替换
│              └─ 提交          → compress.ts        # compaction/start → summary → 替换消息(checkpoint) → end；usage 归入主会话
├── constants.ts              # 共享常量（PLUGIN_LABEL / HISTORY_TAG / COMPACT_CHECKPOINT_PLUGIN）
├── types.ts                  # type-only：宿主类型再导出 + 领域类型（MessageNode / MessageIndex）
├── config.ts                 # 配置默认值 / 校验（缺省、null、空串回退默认值）
├── utils.ts                  # 零依赖工具函数（配置校验 / 文本渲染 / 主会话判定 / 路由解析）
├── log-index.ts              # 消息索引（message_id → 消息事件；recall 消费）
├── summarize.ts              # 观察/反思 persona + 提示词 + fork 摘要子会话（提取子会话 token usage 归入主会话）
├── recall.ts                 # recall 工具
└── compress.ts               # 两级自动压缩（测量 / 区间计算 / 中断扫描 / 对照表 / compaction/* 生命周期事件 + checkpoint 替换）
scripts/                      # release-archive.mjs（CHANGELOG 归档）
tests/                        # vitest 单元测试（52 例）
.dsh/skills/                  # 项目级 skill（feature-defect-workflow：需求/缺陷完成工作流）
```

## 开发计划

- 引入OM消息的语义召回查询
- 将OM和recall分为两个包
