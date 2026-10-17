---
name: real-device-test
description: 在真实 dsh 宿主上端到端实机测试本插件。覆盖单元测试无法验证的部分：宿主装载、mock LLM 后端全链路、CDP 驱动真实浏览器的前端渲染、宿主 API 漂移回归。做版本验收、实机回归、或提到装载/GUI 展示/宿主行为验证时使用。
disable-model-invocation: true
---

# real-device-test

单元测试（`tests/`）覆盖纯逻辑；本 skill 只覆盖常规测试无法兼顾的部分，按四个类别组织：

- **A 宿主装载**：真实 dsh 上 profile 创建、dist 安装、fiber 激活、命令与工具注册、client bundle 下发。
- **B 后端宿主交互**：依赖宿主服务的行为——持久化与冷重启、事件生命周期、turn 阻塞与压缩原子性。
- **C 前端真实渲染**：CDP 驱动真实 Chrome，验证卡片、菜单、面板、配置表单，截图取证。
- **D 宿主 API 漂移**：宿主类型或运行时行为与插件假设不一致导致的失败。

功能会持续变化，本 skill 不写死功能用例。用例按当前版本现场推导，方法见 `references/cases.md`。`scripts/` 是参考实现，复制后按当前功能扩展。

## 阶段 0 环境对齐

1. 读插件 `package.json` 的 `@deepseek-ai/dsh` 依赖版本，作为期望宿主版本。
2. `dsh --version` 比对：未安装或版本不符，先 `npm i -g @deepseek-ai/dsh@<期望版本>`；一致则继续。不要假定测试环境已有 dsh。
3. 仓库内 `pnpm i && pnpm check`（含 build），确保 `dist/` 对应当前 HEAD。
4. 确认本机有 Chrome。Windows 默认路径见 `scripts/chrome-up.sh`。

## 阶段 1 profile 与装载（类别 A）

`bash scripts/setup-env.sh <插件仓库绝对路径> <profile名>` 完成：建 profile（web 模板）→ `pnpm pack` → `dsh plugin add` → 生成 `cordis.patch.yml` → 复制驱动脚本到 profile 目录。

patch 关键点（模板见 setup-env.sh）：

- OM 阈值调大（`observeThresholdTokens`/`reflectThresholdTokens` 设 1000000），由驱动按用例热更新。
- `rateLimitWaitMs: 0`、`tailMessageCount` 按用例、`debug: true`。
- 禁用真实 LLM 与标题模型（llm-deepseek、llm-deepseek-account、llm-pi-ai、session-title-llm）。
- session 持久化与 storage 重定向到 profile 内（`test-sessions`/`test-storage`），与日常数据隔离。
- 末尾 `insert` 加载 `mock-provider.mjs`。

装载断言（驱动首个用例）：插件 entry `fiber.assertActive`；providers 含 mock；命令 `om-recompress`、`om-compaction-eval` 已注册；recall 工具出现在 `requestHeader().tools`；已安装 dist 的版本号与 sha256 同仓库 `dist/index.mjs` 一致。

client 下发断言：GUI 启动后抓 Network，combo URL 含 `dsh-plugin-om/client.js` 且返回 200。

## 阶段 2 mock AI（B、D 的公共基础）

宿主无内置 mock，自写 adapter 继承 `@deepseek-ai/dsh-llm` 的 `LlmAdapter`，参考 `scripts/mock-provider.mjs`：

- 最小流协议：`block-end`（text / tool-call）+ `finish`（stop / tool-calls / max-tokens / error）；`usage` chunk 提供 `inputTokens`，供阈值换算用例。
- compaction 请求按轮次脚本化：round 0 `getHistory`，随后按视图条目发 `compressHistory`，最后 `completeCompression`；错误注入模式（截断、瞬时失败、5xx、彻底失败、ask 重写等）按用例扩展 `modes` 表。
- `ctx.on('user-questions/request')` 对测试会话返回脚本化答案，覆盖真实宿主问答链路。
- 每个请求 append 到 `requests.jsonl`（剔除 signal），事后审计 purpose、tools、messages。
- `listModels`/`resolveModel` 需为测试模型提供 `reasoning.efforts` 元数据，否则思考等级校验会降级。

## 阶段 3 后端实机（类别 B）

驱动骨架 `scripts/run-om-test.mjs`（warm）与 `scripts/run-om-cold.mjs`（cold）。骨架要点：

- `runProfile` 启动 profile（`--no-open --port 0`），取 mock adapter 与插件 loader entry。
- 配置热更新：`entry.update({config})` → `loader.await()` → `fiber.assertActive()`。
- 会话：`agents.create/resume`（provider mock），`followup` + `whenIdle` 带超时驱动一轮。
- 断言以会话落盘事件为事实源：`compaction/start|summary|end`、`feedback/record` 中 `om:1:` 信封、`subagent/catalog`、`turn/end reason`。不信任内存状态。

用例推导（详细方法与本轮示例见 `references/cases.md`）：

1. `git log <上个tag>..HEAD` 与 CHANGELOG 列出宿主交互面。
2. 每个交互面设计 mock 脚本：哪轮发什么工具调用、注入什么错误。
3. 落盘事件级断言，覆盖成功路径、失败路径、原子性。
4. 冷重启类：warm 阶段播种并 dispose，独立进程跑 cold 驱动验证采纳。

原子性断言模板：压缩失败后普通请求数为 0、表层节点不变、pending 标记不失效、`turn/end reason.kind === 'blocked'`、诊断子会话 label 以「-失败」结尾。

验收：`warm-results.json` / `cold-results.json` 全 PASS，退出码 0。

## 阶段 4 前端实机（类别 C）

基础设施（scripts 提供）：

- `bash scripts/chrome-up.sh [端口] [userDataDir]`：专用 Chrome 实例 + CDP。假死（CDP 命令超时）就杀掉重启新实例，不复用旧实例。本环境 headless 不稳定，用普通模式。
- `bash scripts/gui-up.sh <profile名> [端口]`：后台起 GUI，从日志提取 token，导出 `OM_GUI_TOKEN`/`OM_GUI_URL`。
- `node scripts/register-workspace.mjs <profile目录> <仓库绝对路径>`：手工注册工作区（schema 约束见 `references/pitfalls.md`）。

交互配方按 UI 元素类型（`scripts/cdp-ui.mjs` 提供 step 示例）：

- 侧边栏按钮：折叠态只有 aria-label，用 `button[aria-label=...]` 定位。
- 会话搜索：按会话标题搜（不是 sessionId）；输入框先清空（Ctrl+A + Backspace）再 `Input.insertText`。
- 命令面板：必须真实键击 `/`（keyDown + char + keyUp），`insertText` 不触发；选项用 Enter 提交，DOM `el.click()` 无效。
- 聊天节点卡片：三级展开——turn 披露行（button 文本含「用时」）→ 组标题（`O_Ebla_title`）→ 卡片行（`[data-disclosure-row]`）。外层容器 click 无效。
- 卡片内菜单与面板：用 `data-*` 属性定位（`data-om-recompress-model/effort/start`、`.om-eval-panel`、`.om-eval-start`）；effort 文本匹配大小写不敏感。
- 配置表单：插件管理器（侧边栏「插件」）→ 已安装区 → `button[aria-label="配置 <插件名>"]`；输入框用原生 value setter + input 事件；「撤销修改」不写盘。
- 虚拟列表滚动：容器无原生滚动条，用 CDP `Input.dispatchMouseEvent` 的 `mouseWheel` 把目标带入视口再操作。

证据：每个流程 `Page.captureScreenshot` 存 `shots/`，关键断言配截图。

## 阶段 5 宿主 API 漂移（类别 D）

- 写断言前以宿主为事实源：读 `node_modules/@deepseek-ai/*/lib/types/*.d.ts` 与 lib 源码，确认事件载荷形状、surfaceOp 规则、插槽契约、chunk 协议。
- 断言失败先区分「插件缺陷」与「驱动假设过期」：dump 会话落盘 jsonl 与 `requests.jsonl` 核对真实形状。
- 宿主升级后先跑类别 A 装载用例与 D 契约探针，再跑 B、C。
- 本轮踩到的漂移点清单见 `references/pitfalls.md`。

## 阶段 6 报告与清理

- 汇总 warm/cold results json、截图、GUI 流程结论成报告（结构见 `references/cases.md` 末尾）。
- 清理：杀 GUI 端口进程与专用 Chrome；profile、日志、截图保留供复查。
- 全程不改插件业务代码；发现缺陷记入报告，另开分支修复。

## 引用

- `references/cases.md`：用例推导方法 + 本轮用例与 commit 映射示例 + 报告结构。
- `references/pitfalls.md`：坑清单与恢复手段。
- `scripts/`：参考实现。复制到 profile 目录后按本文顺序执行。
