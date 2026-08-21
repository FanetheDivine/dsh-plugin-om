# Changelog

## Unreleased

- feat: 新增浏览器客户端压缩卡片（src/client/ → dist/client.js）：保持压缩替换消息 source.plugin = dsh-plugin-om 不变，插件自注册 conversation 业务定义与 keyed 渲染器，在消息列表展示「已压缩」卡片（计数 + summary 折叠展开）；新增 tests/client/definition.test.ts
- chore: 升级 @deepseek-ai/dsh-* 依赖至 0.1.0-rc.8（rc.6→rc.8 对插件无破坏性变更，typecheck/lint/test/build 全绿）
- chore: 精简完整消息定义串，重写 recall / recall-semantic 工具描述与参数说明、语义模型未就绪提示文案
