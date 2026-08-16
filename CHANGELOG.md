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
