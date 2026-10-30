# Changelog

## Unreleased

## Changes

- `@deepseek-ai/dsh-*` 依赖升级到 0.2.1-rc.5，内核包同步到 `cordis` 4.0.5、`cordis-plugin-loader` 1.0.6、`schemastery` 3.18.5。
- fix: 修复评估组件行启用时 `/om-compaction-eval` 不弹出模型与思考等级选择器的问题。
- Serena 查询复用按项目隔离的后台实例，支持 `status`、`stop`、单进程模式和 15 分钟空闲退出；Windows 启动不弹出控制台。
- Serena 实例使用动态本机端口、启动锁和请求鉴权，停止等待活动请求结束，启动失败回退不重复已提交查询。
- Serena 首次查询只初始化一套语言服务器，同步外部文件变化并统一输出路径为 `/`；初始化失败、崩溃和索引超时直接报错。
- Serena 引用查询激活有效 TS 工程，补全跨 tsconfig 和松散 JS/MJS 引用，空结果不重试。
- 更新 Serena 使用说明和 worktree 清理约定，删除目录前先停止当前项目实例。
