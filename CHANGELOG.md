# Changelog

## Unreleased

## Changes

- refactor!: 拆分为 1 个插件加 1 个组件，共 2 行。`cordis.patch.yml` 按顺序插入包根行 `dsh-plugin-om`（自动压缩、recall、进度提醒、thinking 签名剥离、`/om-recompress` 与全部浏览器界面）和评估行 `dsh-plugin-om-compaction-eval`（`/om-compaction-eval` 命令）。两行在插件页可单独启停。
- feat!: 包根行删除 `omEnabled` 配置，停止压缩改为直接关闭 `dsh-plugin-om` 行，旧键写在包根行上会被忽略。`progressReminderEnabled` 保留，不再受压缩开关联动。
- feat: 包根增加 `description`，包根与评估行各自导出中英文展示元信息，插件页显示各行标题与简介。
- feat: `/om-compaction-eval` 模型面板只在评估行启用时可用，关闭评估行即停用该命令。
- chore: 评估命令的 skill 文档路径改为基于组件入口 `dist/compaction-eval/index.mjs` 解析。
