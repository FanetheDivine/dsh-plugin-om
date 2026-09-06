# dsh-plugin-om

[![npm version](https://img.shields.io/npm/v/dsh-plugin-om.svg)](https://www.npmjs.com/package/dsh-plugin-om)

在 DSH 里应用 [Observational Memory](https://mastra.ai/research/observational-memory) 风格的上下文管理：自动把历史消息压缩为摘要并提供工具回看原始内容。

## 功能

- **自动压缩**：仅主会话，在 agent/pre-step 阻塞串行执行。净压力达到 `observeThresholdTokens` 后再累计 `tailMessageCount` 条完整消息时，把触发点前的全部消息摘要为新 `<history>` 块并精确替换对应消息区间；全部 `<history>` 块 token 合计达到 `reflectThresholdTokens` 时把全部块内条目送入重新压缩，合并为一条更紧凑的摘要。待定标记以 log-only 会话事件持久化，重启后从日志恢复
- **工具驱动压缩**：摘要生成走多轮工具会话，模型经 getHistory 查看区间条目、compressHistory 分批替换 assistant 条目、completeCompression 结束。首条消息仅含压缩指令与 index 区间，不含历史内容。用户消息与系统消息不可压缩且原样保留；未压缩条目原样保留；skill 块首次压缩时要求模型再次确认相关性。最终 `<history>` 块由插件构建，天然合法无需校验
- **压缩会话记录**：每次压缩的工具循环完整对话落盘为 one-shot 子会话，成功为会话记录、失败为失败日志，便于查看模型实际的查看与压缩行为
- **降级容错**：systemPrompt 或 tokenMeter 服务异常时按 0 计继续压缩，问题通过 console 输出与 log-only `om/warning` 会话事件上报，同会话同一问题至多一条
- **recall 工具**：按完整消息 index 区间回看原始会话，含被压缩内容，图片附件随结果保留
- **recall-semantic 工具**：本地嵌入模型 paraphrase-multilingual-MiniLM-L12-v2 按语义检索全部完整消息，只匹配文本，纯图片消息不进候选池
- **压缩卡片**：浏览器客户端渲染折叠式已压缩卡片、压缩中提示行与可展开的失败错误行
- **降级警告行**：浏览器客户端把 om 警告会话事件渲染为可展开的警告行

## 已知风险

- **借用 `feedback/record` 事件**：插件的 log-only 会话事件（警告与观察压缩标记）写入宿主已知类型 `feedback/record` 的 `text` 字段（`om:1:` 前缀 JSON 信封，见 `src/om-event.ts`）。原因是持久化读取路径拒绝目录外未知事件类型而 `Session.append` 不提供 ignorable 写入途径，借用宿主目录内的无配对审计事件是插件写入私有事件的唯一可行通道

## 安装与启用

`$DSH_HOME` 缺省为 `~/.dsh`，profile 描述 dsh 进程的启动模式。

```sh
dsh plugin --profile <profile> add dsh-plugin-om
```

安装完成后重启 dsh，可用 `dsh --profile <profile> --dump-config` 审查配置。

> pnpm 11+ 默认禁止依赖构建脚本，安装失败时把 `$DSH_HOME/profiles/<profile>/pnpm-workspace.yaml` 的 `allowBuilds` 改为 `true`，或安装时追加 `--allow-build=onnxruntime-node --allow-build=protobufjs --allow-build=sharp`

### 配置覆盖

编辑 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`，删除空数组并加入，可热更新：

```yaml
- id: dsh-plugin-om
  config:
    observeThresholdTokens: 45000
```

### 开发插件

运行 `pnpm dev` 构建，本地嵌入模型运行时自动下载，也可 `pnpm run download:model` 预下载。在 `cordis.patch.yml` 加入，可热重载：

```yaml
- insert:
    - id: dsh-plugin-om-dev
      name: file:///<repo>/dist/index.mjs
```

### 与 compaction-basic 的关系

preset-agent 自带 compaction-basic 压缩，阈值为上下文窗口的 80%，一般先用 om 进行压缩。

## 插件配置项

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `observeThresholdTokens` | `45000` | 净压力达到该值时触发观察压缩 |
| `reflectThresholdTokens` | `120000` | 全部 `<history>` 块 token 合计达到该值时触发反思合并 |
| `compressMaxTokens` | 不设置 | 压缩循环单轮生成上限，不设置时由模型适配器默认值决定 |
| `rateLimitWaitMs` | `60000` | 遇 429 限流后下一次压缩请求前的等待毫秒数，`0` 不限流 |
| `tailMessageCount` | `5` | 观察触发后等待新增完整消息达到该条数才执行压缩，`0` 表示触发当轮立即执行 |
| `compressSkipReasoning` | `true` | 工具循环 getHistory 输出是否携带 `<reasoning>` 参考条目，`true` 时不携带，压缩指令同步省略对应说明 |
| `modelDir` | 共享目录 | recall-semantic 嵌入模型目录，默认 `$DSH_HOME/plugin-data/dsh-plugin-om/models/<id>`，onnx 缺失且启用语义召回时运行时自动下载 |
| `omEnabled` | `true` | 是否启用自动压缩，关闭后 recall 工具不受影响 |
| `debug` | dev | 步骤级日志开关，缺省按 `NODE_ENV` 非 production 判定，压缩结果与失败日志始终输出 |
| `recallEnabled` | `true` | 是否注册 `recall` 工具 |
| `semanticRecallEnabled` | `true` | 是否注册 `recall-semantic` 工具，关闭时不触发模型下载 |

> 不建议把观察阈值设置得过高：越早压缩收益越高，且机制依赖模型对消息计数，过多消息会导致历史混乱。

> 想直观理解机制并估算不同参数下的 token 成本，可打开交互式[机制说明与成本计算器](https://fanethedivine.github.io/dsh-plugin-om/)。

## npm 命令

| 命令 | 作用 |
| --- | --- |
| `pnpm check` | typecheck + lint + test + build |
| `pnpm typecheck` | TypeScript 类型检查 |
| `pnpm lint` / `pnpm format` | 代码检查 / 格式化 |
| `pnpm test` | vitest 单元测试 |
| `pnpm run download:model` | 手动预下载嵌入模型，已存在跳过，`--force` 重下 |
| `pnpm build` / `pnpm dev` | 构建 / 自动打包 |
| `pnpm run release` | check → CHANGELOG 归档 → 版本号更新 → 打 tag 推送 |

## 文件地图

```
cordis.patch.yml                 # bundle patch，dsh plugin add 后作为组合层插入插件行
src/
├── index.ts                     # 打包入口：注册 recall 工具并接线 pre-step 自动压缩
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
├── recall.ts                    # recall 工具：按完整消息 index 区间回看
├── recall-output.ts             # recall 输出契约：{ text, images } 与 render 投影
├── semantic-recall.ts           # recall-semantic 工具：本地嵌入语义检索
├── embedding.ts                 # 本地 ONNX 嵌入：懒加载、批量、运行时按需下载编排
├── model-download.ts            # 模型下载原语：URL、跳过判定、原子落盘
├── compress-view.ts             # 压缩视图：观察与反思区间到统一条目序列的投影与渲染
├── compress-tools.ts            # 压缩工具状态机：getHistory/compressHistory/completeCompression 与最终块构建
├── compress-loop.ts             # 工具压缩循环：多轮请求、工具执行、限流与失败判定、usage 汇总
├── compaction-log.ts            # 压缩会话记录落盘：循环对话消息组子会话（成功记录与失败日志）
├── compress.ts                  # 两级自动压缩：观察与反思、失败中断传播、compaction 生命周期事件
└── client/                      # 浏览器客户端 bundle：压缩卡片
    ├── index.ts                 # 客户端入口：注册卡片定义与渲染器
    ├── definition.ts            # 压缩卡片业务定义：认领生命周期事件、检查点替换与 om 警告事件
    ├── OmCompactionCard.tsx     # 折叠卡片渲染器：统计标题与 summary、失败报错展开
    ├── OmWarningCard.tsx        # 功能降级警告行渲染器：折叠摘要与完整说明展开
    ├── format.ts                # 统计数字紧凑格式化：k、w、M
    └── locales.ts               # om-compaction 文案字典：zh 与 en
models/                          # 嵌入模型目录：小文件随包分发，onnx 运行时按需下载，不进 git
scripts/                         # release-archive.mjs 为 CHANGELOG 归档脚本，download-model.mjs 为预下载 CLI
tests/                           # vitest 测试：服务端各模块、客户端卡片、成本模型与整条链路集成测试
web/                             # 机制说明与成本计算器站点：独立 Vite + React + Tailwind CSS + shadcn/ui 工程，发布到 GitHub Pages，不随插件包分发
    ├── src/model.ts             # 成本模型纯函数：om 开关全会话模拟与三类 token 计价
    └── src/components/          # 机制简述、侧边栏参数面板、合并单元格成本表、shadcn/ui 原语
.github/workflows/web-deploy.yml # web/ 变更合入 main 时构建并部署 GitHub Pages
```
