# Changelog

## Unreleased

## Changes

- refactor!: 拆分为 1 个插件加 2 个组件，共 3 行。`cordis.patch.yml` 按顺序插入包根行 `dsh-plugin-om`（自动压缩、recall、进度提醒、thinking 签名剥离与全部浏览器界面）、`dsh-plugin-om-recompress`（`/om-recompress` 命令）、`dsh-plugin-om-compaction-eval`（`/om-compaction-eval` 命令）。每行在插件页可单独启停，各有自己的配置页。
- feat: 包根行提供 `omCompaction` 服务，实时暴露压缩配置。重压缩行从该服务读取 `compressMaxTokens`、`compressSkipReasoning`、`rateLimitWaitMs`，包根行关闭时重压缩行自动停用。评估行不依赖包根行。
- feat!: 包根行删除 `omEnabled` 与 `recompressConcurrency` 配置。停止压缩改为直接关闭 `dsh-plugin-om` 行。`recompressConcurrency` 迁到 `dsh-plugin-om-recompress` 行，旧键写在包根行上会被忽略，组件按默认值运行。`progressReminderEnabled` 保留在包根行，不再受压缩开关联动。
- feat: 包根增加 `description`，三行各自导出中英文展示元信息，插件页显示各行标题与简介。
- feat: 压缩卡片的重压缩菜单只在重压缩行启用时注入，`/om-compaction-eval` 模型面板只在评估行启用时可用。
- chore: 评估命令的 skill 文档路径改为基于组件入口 `dist/compaction-eval/index.mjs` 解析。
