# 坑清单与恢复手段

按「现象 → 原因 → 处置」组织。写断言或排障前先过一遍。

## 宿主契约（类别 D 高频漂移点）

1. **事件载荷形状**：`user/message` 的消息体在 `e.data`，其余消息事件在 `e.data.message`。驱动统一用 `msgOf(e)` 取值，不要凭记忆。
2. **surfaceOp 规则**：surface-eligible 事件必须带 `surfaceOp`——`'append'`（字符串）或 `{op:'replace',startSeq,endSeq}`（恰好三键）。`sourceEventSeqs` 需密集、无重复、全部指向更早事件、覆盖每个被遮蔽节点；`assistant/message` 不得携带 `sourceEventSeqs`。手工 append 测试事件违反规则会抛 `invalid replace surfaceOp`。
3. **OM 私有事件**：经宿主 `appendPluginRecord` 写入，类型 `plugin:dsh-plugin-om/<名>`（warning、observe-pending、observe-invalidate、observe-summary），`ignorable: true`，载荷即 `e.data`。读侧用 `pluginRecordOf` 或直接按 `type` 过滤。
4. **getHistory 返回**：不带根标签的条目 XML。mock 识别视图要按 `<assistant` / `<user_message` / `<skill_content` / `<ask-user-question` / `<history` 匹配，不能只找 `<history`。
5. **mock 模型元数据**：`resolveModel` 不提供 `reasoning.efforts`，思考等级校验会降级并 reportDegrade。给测试模型声明 efforts 列表。
6. **宿主回放行为**：无签名 reasoning 是否回放由宿主决定且可能变化。先 dump 实际请求再写断言方向，不要假设。
7. **导出形态与类型字段**：宿主包是 default export 类还是命名导出模块，以 `lib/types/index.d.ts` 为准。命名导出模块（如 `session-persistence-jsonl` 导出 `name/Config/apply`）用 `import * as X` 后 `ctx.plugin(X, config)`。客户端快照类型（如 `ConfigFormSnapshot`）的字段同样以 d.ts 为准。
8. **服务静默挂起**：挂载不报错但 `ctx.<服务>` 为 undefined，是 fiber 停在 pending。按 `Ctor.inject` 递归核对依赖，补齐缺失服务。例：`SubagentRuntime` 注入 `workingDirectory`，`WorkingDirectoryService` 又注入 `fs`、`sessionProjections`、`systemPrompt`。

## 后端驱动（类别 B）

9. **会话目录残留**：固定 sessionId 与残留的 `test-sessions/` 目录冲突，表现为一串 `SessionAlreadyExistsError`。warm 驱动启动时自动清理 `test-sessions`、`test-storage`、`requests.jsonl` 与结果文件；cold 依赖 warm 产物，不清理，只能紧跟 warm 运行。装载检查失败时 warm 直接中止，避免后续用例连带 `undefined` 误报。装载断言里的插件版本取自仓库 `package.json`，不要写死。
10. **阈值换算**：mock 的 usage chunk `inputTokens = ceil(字符/4) × usageMultiplier`。换算比用例靠调 multiplier 触发，不要调阈值以外的东西。
11. **后台预压缩与注入时机**：到期判定是「已落盘完整消息 + 本轮新增 ≥ tailMessageCount」。注入可能发生在比预期早一轮，断言用「≥ 某轮出现」而非钉死轮次。
12. **cold 驱动内存态**：重启后 `adapter.calls` 清零，「零重压缩」断言用 cold 进程自身的 compCalls==0，不要读 warm 计数。

## 浏览器（类别 C）

13. **Chrome 假死**：CDP 命令全部超时，常因 tab 积压，页面停在 about:blank。处置顺序：查 `/json/list`，对指向 GUI 端口的积压 tab 调 `/json/close/<id>`；无效再杀进程重启全新实例。杀进程用 `netstat -ano | grep ':9334' | grep LISTEN` 取 PID，再 `taskkill //PID <pid> //T //F`；MSYS 会展开 PowerShell 的 `$_`，按 CommandLine 匹配不可用。`headless=new` 在本环境导航挂起，用普通模式。
14. **自写探针**：`/json/new` 只接受 PUT，GET 返回 `Using unsafe HTTP verb` 文本。关 tab 用路径形式 `/json/close/<id>`，查询串形式 `?<id>` 被静默忽略，tab 持续积压。先开新 tab 再关旧 page，关光所有 page 会让 Chrome 退出。探针放 profile 目录跑，`/tmp` 下解析不到 `ws`。多行 JS 表达式用 write 工具写文件，`node -e` 与 heredoc 会吞反引号和 `$`。
15. **GUI token 轮转**：每次启动 token 不同，从 gui 日志提取。浏览器有持久 cookie 时 curl 401 不代表 GUI 挂了。冷启动可能超过 30s，`gui-up.sh` 等 token 的秒数由 `OM_GUI_WAIT` 覆盖。
16. **workspace.json schema**：`path` 必须绝对路径（Windows 反斜杠在 bash heredoc 会被吞，用 node 脚本或 `String.fromCharCode(92)` 拼）；`createdAt/updatedAt` 必须 ISO 字符串（数字会 ZodError，workspace 不激活，GUI 停在「正在加载工作区…」）。
17. **侧边栏折叠态**：按钮只剩 aria-label 无文本，`clickByText` 失效，改 `button[aria-label=...]`。
18. **会话搜索**：按标题搜（侧边栏显示 session/title，不是 sessionId；标题取会话 jsonl 最后一条 `session/title`）。搜索框先 Ctrl+A + Backspace 清空再 `Input.insertText`；insertText 偶发不生效，用原生 value setter + input 事件兜底并校验 value。结果行在 `[class*="searchTree"]` 内，不在 aside。侧边栏会话列表会折叠到「展开其余 N 个会话」，不要直接在 aside 里找会话行。GUI 会恢复上次路由，子会话面包屑含父会话标题，按标题判断「已打开」时须排除子会话。
19. **命令面板**：`insertText` 打 `/` 不触发 palette，必须真实键击序列 keyDown(key:'/',code:'Slash',vk:191) + char + keyUp。palette 选项 DOM `el.click()` 无效，输入过滤后按 Enter 提交。
20. **卡片三级展开**：卡片被折进 turn 进程组且组被 `hidden`。顺序：点所有文本含「用时」的披露 button → 点组标题 `O_Ebla_title`（DOM click 有效）→ 点卡片行 `[data-disclosure-row]`（role=button；外层 `.om-compaction-root` click 无效）。
21. **卡片按钮文案**：以插件 `src/client/locales.ts` 的 `card.*` 键为准（如 `card.trajectory`、`card.inspect`），不凭记忆。按单个 button 的 textContent 全等匹配；容器 textContent 会把相邻按钮拼成一串，不能据此推断按钮名。
22. **虚拟列表定位**：容器无原生滚动条，`scrollIntoView`/scrollTop 被重置（rect.y 恒为负）。用 CDP `mouseWheel` 循环把目标滚进视口（y 落在 120 ~ vh-160）再取坐标。
23. **effort 文本**：面板显示「模型默认/Low/Medium/High」，匹配用小写化 + endsWith，不要全等 'low'。
24. **配置表单入口**：设置弹窗不渲染插件 configForms，入口在插件管理器详情页。路径：侧边栏 `button[aria-label="插件"]`（无文本）→ 已安装区为空时点 `button[aria-label="刷新"]` → 列表卡片 `button[aria-label="查看 <插件名>"]` 进详情页 → 组件行 `button[aria-label="配置 <插件名>"]` 打开表单。「查看」在列表卡片，「配置」只在详情页，两者不是同一按钮。表单字段用原生 setter 触发 React 受控更新；「撤销修改」只回滚表单不写盘，验证时核对 patch 文件未变。
25. **截图取证**：整页截图可能因折叠裁剪看不到卡片，用元素矩形 clip 截图；截图与 DOM 断言互为佐证，DOM 是决定性证据。

## 环境（阶段 0）

26. **本地宿主解析**：全局 dsh 与期望版本不一致时走本地宿主（`~/.dsh-local/dsh-<版本>`）。驱动与 mock-provider 默认按 `npm root -g` 解析宿主包，未设 `OM_DSH_PKG` 会静默加载全局版本，表现为 `readEnv`、`reading 'session'` 等 TypeError。跑驱动、起 GUI 前都要 export `OM_DSH_PKG` 并前置本地 bin 到 PATH。
27. **pnpm 忽略 build scripts**：profile 安装后 `onnxruntime-node`、`sharp` 等被 ignored，语义检索不可用。测试默认 `semanticRecallEnabled: false`；需要时 `pnpm approve-builds`。
28. **端口占用**：GUI 端口残留进程导致 `EADDRINUSE`、连锁多插件不激活。netstat 找 PID taskkill 后重启；启动日志出现 `did not activate` 先查端口。
29. **sessionController 偶发缺失**：全新 profile 首跑 `/om-compaction-eval` 报「宿主未提供 sessionController 服务」，而配置与已验证 profile 完全一致——bundle 激活偶发。处置：直接重跑 warm（启动时自动清残留，实测恢复 19/19）；仍复现则查 runProfile 启动日志中 webserver 与 remotes 是否激活。
