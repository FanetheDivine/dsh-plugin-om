# Changelog

## Unreleased

### Added

- 支持通过 `compressProvider` 与 `compressModel` 成对配置压缩请求使用的模型，成对配置后覆盖会话路由，未路由会话也会执行压缩
- 新增 `compressReasoningEffort` 配置压缩请求的思考等级，配置值经目标模型校验，不支持时降级为模型默认思考等级并输出 `reasoning-effort-unavailable` 警告
- compaction/summary 载荷记录实际生效的思考等级
