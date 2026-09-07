# Changelog

## [0.0.33] - 2026-09-07

## Unreleased

- 观察阈值（`observeThresholdTokens`）默认改为 35000 tokens、反思阈值（`reflectThresholdTokens`）默认改为 40000 tokens、尾部保留条数（`tailMessageCount`）默认改为 20
- `<history>` 块块首格式说明注释精简：去掉「条目正文一律以 CDATA 包裹」与 `<skill_content>` 两段结构说明，改为「消息块的内容是用CDATA包裹的纯文本」「`<skill_content>` 表示未压缩的原始 skill」，降低块首固定 token 占用
- `<history>` 块与 getHistory 输出中空的 `<sys>` 条目不再包裹空 CDATA，改为自闭合空元素 `<sys type="…" index="N"/>`
- README 调整 `compressSkipReasoning` 说明：表格下方补充按模型选择开关的指引，thinking 输出质量差且会把关键结论以 text 形式输出的模型保持默认开启，如 glm 和 deepseek 系列；使用 openai/responses 或 anthropic/messages API 时建议关闭；携带 reasoning 大约使 input_tokens 增加 40%
- 调整readme
