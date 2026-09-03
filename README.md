# dsh-plugin-om

[![npm version](https://img.shields.io/npm/v/dsh-plugin-om.svg)](https://www.npmjs.com/package/dsh-plugin-om)

在 DSH 里应用 [Observational Memory](https://mastra.ai/research/observational-memory) 风格的上下文管理策略：自动把历史消息压缩为摘要，并提供工具回看原始内容。

## 功能

- **自动压缩**（仅主会话，`agent/pre-step` 时阻塞串行执行）：
  - **观察**：净压力（上下文压力 − 已压缩 `<history>` 块 token 估算合计 − 系统提示词 token 估算 − 工具定义 token 估算）≥ `observeThresholdTokens` 时，摘要未压缩消息并追加为新 `<history>` 块，精确替换被压缩的消息区间（旧块保留）
  - **反思**：全部 `<history>` 块 token 合计 ≥ `reflectThresholdTokens` 时，把多个摘要块合并为一条更紧凑的摘要
  - **输出容错**：摘要输出按首个 `<history>` 开标签到最后一个 `</history>` 定位；整块 XML 非法时按条目标签模糊提取并重建为合法块，再校验无 reasoning 与 index 连续
  - **失败中断**：摘要尝试全部耗尽后拒绝当前 step（当前 turn 以 blocked 结束，不再继续 AI 会话；signal 中止除外），最后一次尝试的实际报错写入日志与 `compaction/end` error
- **recall 工具**：按完整消息 index 区间回看原始会话（含被压缩内容；命中消息中的图片附件随结果保留）
- **recall-semantic 工具**：本地嵌入模型（paraphrase-multilingual-MiniLM-L12-v2）按语义检索全部完整消息（只匹配文本，纯图片消息不进候选池）
- **压缩卡片**：浏览器客户端在消息列表渲染折叠式「已压缩」卡片、「正在压缩上下文（观察/反思）…」提示行与可展开的「上下文压缩失败」错误行

## 安装与启用

- `$DSH_HOME` 缺省为 `~/.dsh`；*profile* 描述 dsh 进程的启动模式（官方启动命令即名为 `web` 的 profile）

```sh
dsh plugin --profile <profile> add dsh-plugin-om
```

安装完成后重启 dsh；可用 `dsh --profile <profile> --dump-config` 审查配置。

> pnpm 11+ 默认禁止依赖构建脚本，安装失败时把 `$DSH_HOME/profiles/<profile>/pnpm-workspace.yaml` 的 `allowBuilds` 改为 `true`，或使用
> `dsh plugin --profile <profile> add dsh-plugin-om --allow-build=onnxruntime-node --allow-build=protobufjs --allow-build=sharp`

覆盖默认配置：编辑 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`，删除空数组并加入（可热更新）：

```yaml
- id: dsh-plugin-om
  config:
    observeThresholdTokens: 45000
```

### 开发插件

运行 `pnpm dev` 构建（本地嵌入模型运行时自动下载，也可 `pnpm run download:model` 预下载），在 `cordis.patch.yml` 加入（可热重载）：

```yaml
- insert:
    - id: dsh-plugin-om-dev
      name: file:///<repo>/dist/index.mjs
```

### 与 compaction-basic 的关系

preset-agent 自带 `compaction-basic` 压缩，也会压缩上下文，其压缩阈值为 80% 上下文窗口，一般会先用om进行压缩。

## 插件配置项

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `observeThresholdTokens` | `45000` | 观察阈值（tokens）：净压力（上下文压力 − 已压缩块 − 系统提示词估算 − 工具定义估算）≥ 该值时触发观察压缩 |
| `reflectThresholdTokens` | `120000` | 反思阈值（tokens）：全部 `<history>` 块 token 合计 ≥ 该值时触发合并 |
| `compressMaxTokens` | 不设置 | 单次摘要生成上限（不设置时由模型适配器默认值决定） |
| `rateLimitWaitMs` | `60000` | 遇 429 限流后下一次摘要请求前的等待毫秒数（全局冷却期；`0` 不限流） |
| `tailMessageCount` | `5` | 尾部保留的不压缩消息条数 |
| `compressRetryCount` | `5` | 摘要失败后的最大重试次数（不含首次） |
| `modelDir` | 共享目录 | recall-semantic 嵌入模型目录（默认 `$DSH_HOME/plugin-data/dsh-plugin-om/models/<id>`，onnx 缺失且启用语义召回时运行时自动下载） |
| `omEnabled` | `true` | 是否启用自动压缩（`false` 时关闭，recall 工具不受影响） |
| `debug` | dev | 步骤级日志开关（缺省按 `NODE_ENV !== 'production'` 判定；每次压缩尝试的结果/报错与失败日志始终输出） |
| `recallEnabled` | `true` | 是否注册 `recall` 工具 |
| `semanticRecallEnabled` | `true` | 是否注册 `recall-semantic` 工具（`false` 时不注册、不触发模型下载） |

> 不建议把观察阈值设置得过高：越早压缩收益越高，且机制依赖模型对消息计数，过多消息会导致历史混乱。

## npm 命令

| 命令 | 作用 |
| --- | --- |
| `pnpm check` | typecheck + lint + test + build |
| `pnpm typecheck` | TypeScript 类型检查 |
| `pnpm lint` / `pnpm format` | 代码检查 / 格式化 |
| `pnpm test` | vitest 单元测试 |
| `pnpm run download:model` | 手动预下载嵌入模型（已存在跳过，`--force` 重下） |
| `pnpm build` / `pnpm dev` | 构建 / 自动打包 |
| `pnpm run release` | check → CHANGELOG 归档 → 版本号更新 → 打 tag 推送 |

## 文件地图

```
cordis.patch.yml               # bundle patch：dsh plugin add 后作为组合层插入插件行
src/
├── index.ts                   # 打包入口：注册 recall 工具 + 接线 pre-step 自动压缩
├── config.ts                  # 配置默认值与宽松合并（未知键忽略、非法值回退默认）
├── constants.ts               # 共享常量（插件标识 / history 标签 / 完整消息定义）
├── types.ts                   # type-only：宿主类型再导出 + 领域类型
├── utils.ts                   # 零依赖工具函数（文本渲染 / 主会话判定 / 路由解析）
├── logger.ts                  # 插件日志门面（step 按 debug 开关过滤）
├── rate-limit.ts              # 全局 429 限流冷却门（进程级共享状态）
├── log-index.ts               # 完整消息索引与渲染（recall 与摘要共用同一套编号）
├── recall.ts                  # recall 工具：按完整消息 index 区间回看
├── recall-output.ts           # recall 输出契约：{ text, images } 与 render 投影
├── semantic-recall.ts         # recall-semantic 工具：本地嵌入语义检索
├── embedding.ts               # 本地 ONNX 嵌入（懒加载 / 批量 / 运行时按需下载编排）
├── model-download.ts          # 模型下载原语（URL / 跳过判定 / 原子落盘）
├── summarize.ts               # 共享压缩提示词 + <history> 块渲染与输出校验 + 摘要调用
├── compress.ts                # 两级自动压缩（观察/反思）、失败中断传播与 compaction 生命周期事件
└── client/                    # 浏览器客户端 bundle（压缩卡片）
    ├── index.ts               # 客户端入口：注册卡片定义与渲染器
    ├── definition.ts          # 压缩卡片业务定义（认领生命周期事件与替换检查点）
    ├── OmCompactionCard.tsx   # 折叠卡片渲染器（统计标题 + summary/失败报错展开）
    ├── format.ts              # 统计数字紧凑格式化（k/w/M）
    └── locales.ts             # om-compaction 文案字典（zh/en）
models/                        # 嵌入模型目录（小文件随包分发；onnx 运行时按需下载，不进 git）
scripts/                       # release-archive.mjs（CHANGELOG 归档）/ download-model.mjs（预下载 CLI）
tests/                         # vitest 单元测试（服务端各模块 + tests/client/ 客户端卡片）
```

