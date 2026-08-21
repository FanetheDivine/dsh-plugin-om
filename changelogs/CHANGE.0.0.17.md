# Changelog

## [0.0.17] - 2026-08-21

## Unreleased

- chore: 升级 @deepseek-ai/dsh-* 依赖至 0.1.1-rc.1（rc.8→0.1.1-rc.1 对插件无破坏性变更，typecheck/lint/test/build 全绿）
- fix: 修复 tsconfig.json 排除 src/client 导致编辑器与 `tsc --noEmit` 无法检查客户端类型的问题——基础 tsconfig 直接纳入 client（补 dom lib + react-jsx），删除冗余的 tsconfig.client.json，typecheck 简化为 `tsc --noEmit`
- feat: 压缩卡片改用与宿主「上下文注入」卡片同款样式（DisclosureRow + IconBrowseOutline16 + 同款样式注入），标题统计补充压缩前后估算 token（压缩后按 4 字符 ≈ 1 token 客户端估算，与服务端 estimateTextTokens 同启发式）
- feat: 压缩卡片标题直接展示「压缩前 N 条消息 · X 字符 → 压缩后 Y 字符」（服务端 compaction/summary 新增扩展字段 shadowedCharCount，宿主 append 原样持久化；旧载荷回落为 token 计数），摘要体改为代码块样式（缩小字号、代码背景与等宽字体、保留换行）
- feat: 新增浏览器客户端压缩卡片（src/client/ → dist/client.js）：保持压缩替换消息 source.plugin = dsh-plugin-om 不变，插件自注册 conversation 业务定义与 keyed 渲染器，在消息列表展示「已压缩」卡片（统计标题 + summary 折叠展开）；新增 tests/client/definition.test.ts
- chore: 升级 @deepseek-ai/dsh-* 依赖至 0.1.0-rc.8（rc.6→rc.8 对插件无破坏性变更，typecheck/lint/test/build 全绿）
- chore: 精简完整消息定义串，重写 recall / recall-semantic 工具描述与参数说明、语义模型未就绪提示文案
