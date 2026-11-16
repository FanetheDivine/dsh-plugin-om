# 开发

## 本地加载

运行 `pnpm dev` 自动构建，并在 `cordis.patch.yml` 中加载本地 bundle：

```yaml
- insert:
    - id: dsh-plugin-om-dev
      name: file:///<repo>/dist/index.mjs
    - id: dsh-plugin-om-compaction-eval-dev
      name: file:///<repo>/dist/compaction-eval/index.mjs
```

## 热更新

开启热更新时，在同一文件启用 `hmr` 并监听 `dist`。仓库路径含 `.dsh`（如 worktree）时去掉默认忽略的 `**/.*`：

```yaml
- id: hmr
  disabled: false
  config:
    root: ["<repo>/dist"]
    ignored: ["**/node_modules"]
```

## 热更新

- 改动补丁后无需重启 DSH，运行中的 profile 会重新协调补丁。
- `pnpm dev` 重建 `dist` 后，服务端命令和浏览器端面板都会自动更新，已打开的页面无需刷新。
- 插件行指向新路径时同时改 `id`，确保重新加载新路径的模块。
- 重载不改写会话历史，可能改变后续请求前缀，影响 KV Cache。
- 排查时检查命令首条消息里的评估文档路径，应位于当前仓库的 `dist/skill`。

## 嵌入模型

开启语义增强时插件在后台自动下载嵌入模型，也可运行 `pnpm run download:model` 预下载。

## Serena

Serena 符号查询需要 uv、Node.js 和 Python 3.11–3.14。安装依赖时自动准备 Serena，也可运行 `pnpm serena:setup` 手动准备。

- 查询复用当前项目的独立后台实例。Windows 启动不弹出控制台。
- 实例默认空闲 15 分钟退出。`SERENA_CLI_IDLE_TIMEOUT` 可设置空闲秒数。
- `references` 激活 TS 工程并补全松散 JS/MJS 引用。空结果不重试，初始化失败或超时直接报错。
- 查询前同步外部文件改动。输出行号从 1 开始，路径使用 `/`。
- `--no-daemon` 或 `SERENA_CLI_DAEMON=0` 使用单进程。实例启动失败会提示并回退，已提交的查询不重复执行。
- 删除 worktree 前在目标目录执行 `pnpm serena stop`，确认停止后离开目录再删除。

## 命令

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | 监听并构建 |
| `pnpm check` | 检查类型、lint、测试和构建 |
| `pnpm test` | 运行测试 |
| `pnpm serena definition <name_path>` | 寻找符号定义 |
| `pnpm serena references <name_path>` | 寻找符号引用 |
| `pnpm serena doc <name_path>` | 查看符号签名和注释 |
| `pnpm serena status` | 查看当前项目实例状态 |
| `pnpm serena stop` | 停止当前项目实例 |
| `pnpm serena:setup` | 准备 Serena Python 依赖 |
| `pnpm run download:model` | 预下载嵌入模型 |
| `pnpm run release` | 检查并发布新版本 |

## 文件地图

```text
cordis.patch.yml                 # bundle patch，按顺序插入包根行与评估组件行
locale/                          # 包根与评估行的中英文展示元信息
docs/                            # 开发者文档：工作机制、已知风险与开发说明
src/
├── index.ts                     # 包根入口：注册 recall 工具，接线自动压缩和提醒补发
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
├── compaction-eval-command.ts   # OM 结果评估命令：定位评估文档、新建同工作区会话并投递首条消息
├── compaction-eval/index.ts     # 评估行入口：注册 /om-compaction-eval
├── eval-session-text.ts         # 评估命令文本契约：命令名与描述、首条消息、成功文本与其反解
└── client/                      # 浏览器客户端 bundle：压缩卡片、包根配置页与评估行门控
    ├── index.ts                 # 注册卡片与渲染器，为包根注册配置页，按评估行启用状态门控模型面板
    ├── om-config-controller.ts  # 包根配置页的字段布局、宿主配置表单、草稿和原子保存
    ├── OmConfigCard.tsx         # 按字段布局渲染的双语配置控件
    ├── definition.ts            # 压缩卡片定义：生命周期事件、检查点替换与警告事件
    ├── OmCompactionCard.tsx     # 压缩结果与错误卡片，可跳转轨迹与诊断子会话
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
