# Changelog

## Unreleased

## Changes

- `@deepseek-ai/dsh-*` 依赖升级到 0.2.2-rc.3。
- 测试适配宿主新契约：子代理目录改读 `subagentCatalog` 投影，`agents.create` 不再接受 `parentAgent`。
- 默认阈值提高：`observeThresholdTokens` 改为 55000、`reflectThresholdTokens` 改为 120000，未显式配置的 profile 更晚触发观察与归档。
- README 改为面向用户：精简功能、配置说明与注意事项，插件详情页描述同步更新。
- 机制细节、已知风险、开发说明与文件地图拆到 `docs/how-it-works.md`、`docs/known-risks.md` 和 `docs/development.md`，由 AGENTS.md 索引。
