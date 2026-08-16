# Changelog

- feat: recall-semantic 模型改为运行时按需下载（下载核心迁入 src/model-download.ts，移除 prepack；apply 后台预热，未就绪时工具告知模型；README 同步依赖策略/配置/环境变量/文件地图）
- chore: recall-semantic 模型二进制不进入 git 仓库（构建/发布时下载，规避 GitHub 单文件 >100MB 限制）
- feat: 增加环境变量限制 recall 能力（OM_RECALL_ENABLED / OM_SEMANTIC_RECALL_ENABLED，值恰为 false 时禁用对应工具）
- docs: README 同步 recall-semantic（工作原理/配置/工具说明/文件地图）
- test: recall-semantic 用例（schema/区间/排序/遮蔽/回退/pruner/守卫）
- feat: 接线 recall-semantic（apply 注册 + modelDir 配置）
- feat: recall-semantic 工具（query 语义检索 + 区间限定 + 回退全量 + 匹配说明）
- feat: 本地 ONNX 嵌入引擎（懒加载单例 + 批量 embed + cosine 相似度）
- feat: 引入本地多语言嵌入模型（recall-semantic 依赖，同步 pnpm-workspace 依赖白名单）
- 优化skill
- feat: 压缩时机支持 turn 中间触发——`computeCompressRange` 去掉 turn/end 封顶，pre-step 时日志 call-result 完备即可压缩当前 turn 消息；区间终点回退到 tool-call/result 配对平衡点（不切段）
- feat: 摘要改直连 `ctx.llm.stream()`（不再 fork 子会话），新增环境变量 `DSH_OM_SUMMARY_MODE` 双模式：`prefix`（缺省）复用主会话 `requestHeader()` 的 system/tools 与完整派生历史 + 末尾指令 user 消息（充分利用 provider 前缀缓存）；`system` 模式指令作为 system、被压缩消息与参考尾部作为 user 输入；usage 从流式 usage chunk 提取归入主会话
- feat: `tailMessageCount` 语义改为「不压缩的消息」（尾部保留、不参与替换），同时作为摘要模型的参考尾部（摘要须准确反映最近上下文进度/下一步）
- docs: 同步 README（工作原理 / 配置项与环境变量 / 调用链文件地图）与 CHANGELOG
