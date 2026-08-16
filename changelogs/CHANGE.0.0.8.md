# Changelog

## [0.0.8] - 2026-08-16

- feat: 优化压缩提示词——移除 persona 身份前缀与中断标记注入（中断由 AI 自主判断），压缩格式改为按模块整体摘要（<assistant start/end>：连续消息模块、背景/目的/行为/结果、文件路径合并简写、最后模块含下一步计划），新增「本指令不入日志」与「index/start/end 必须连续」规则
- docs: README 安装章节补充 pnpm 11 构建脚本注意（`ERR_PNPM_IGNORED_BUILDS` 失败原因、一行命令 `--allow-build` 放行 onnxruntime-node/protobufjs/sharp 或 `pnpm approve-builds --all` 的修复步骤，非插件缺陷无需改代码）
