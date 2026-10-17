# 坑清单与恢复手段

按「现象 → 原因 → 处置」组织。写断言或排障前先过一遍。

## 宿主契约（类别 D 高频漂移点）

1. **事件载荷形状**：`user/message` 的消息体在 `e.data`，其余消息事件在 `e.data.message`。驱动统一用 `msgOf(e)` 取值，不要凭记忆。
2. **surfaceOp 规则**：surface-eligible 事件必须带 `surfaceOp`——`'append'`（字符串）或 `{op:'replace',startSeq,endSeq}`（恰好三键）。`sourceEventSeqs` 需密集、无重复、全部指向更早事件、覆盖每个被遮蔽节点；`assistant/message` 不得携带 `sourceEventSeqs`。手工 append 测试事件违反规则会抛 `invalid replace surfaceOp`。
3. **OM 信封**：借用 log-only 的 `feedback/record`，text 前缀 `om:1:` + JSON。解码 `text.slice(5)` 后 `JSON.parse`。
4. **getHistory 返回**：不带根标签的条目 XML。mock 识别视图要按 `<assistant` / `<user_message` / `<skill_content` / `<ask-user-question` / `<history` 匹配，不能只找 `<history`。
5. **mock 模型元数据**：`resolveModel` 不提供 `reasoning.efforts`，思考等级校验会降级并 reportDegrade。给测试模型声明 efforts 列表。
6. **宿主回放行为**：无签名 reasoning 是否回放由宿主决定且可能变化。先 dump 实际请求再写断言方向，不要假设。

## 后端驱动（类别 B）

7. **会话目录残留**：固定 sessionId 与残留的 `test-sessions/` 目录冲突。重跑前清理 `test-sessions`、`test-storage`、`requests.jsonl` 与结果文件。
8. **阈值换算**：mock 的 usage chunk `inputTokens = ceil(字符/4) × usageMultiplier`。换算比用例靠调 multiplier 触发，不要调阈值以外的东西。
9. **后台预压缩与注入时机**：到期判定是「已落盘完整消息 + 本轮新增 ≥ tailMessageCount」。注入可能发生在比预期早一轮，断言用「≥ 某轮出现」而非钉死轮次。
10. **cold 驱动内存态**：重启后 `adapter.calls` 清零，「零重压缩」断言用 cold 进程自身的 compCalls==0，不要读 warm 计数。

## 浏览器（类别 C）

11. **Chrome 假死**：CDP 命令全部超时、tab 累积。处置：按 CommandLine 匹配 user-data-dir 杀进程，重启全新实例；每步跑前可强制重启。`headless=new` 在本环境导航挂起，用普通模式。
12. **GUI token 轮转**：每次启动 token 不同，从 gui 日志提取。浏览器有持久 cookie 时 curl 401 不代表 GUI 挂了。
13. **workspace.json schema**：`path` 必须绝对路径（Windows 反斜杠在 bash heredoc 会被吞，用 node 脚本或 `String.fromCharCode(92)` 拼）；`createdAt/updatedAt` 必须 ISO 字符串（数字会 ZodError，workspace 不激活，GUI 停在「正在加载工作区…」）。
14. **侧边栏折叠态**：按钮只剩 aria-label 无文本，`clickByText` 失效，改 `button[aria-label=...]`。
15. **会话搜索**：按标题搜（侧边栏显示 session/title，不是 sessionId）。搜索框先 Ctrl+A + Backspace 清空再 `Input.insertText`；insertText 偶发不生效，用原生 value setter + input 事件兜底并校验 value。
16. **命令面板**：`insertText` 打 `/` 不触发 palette，必须真实键击序列 keyDown(key:'/',code:'Slash',vk:191) + char + keyUp。palette 选项 DOM `el.click()` 无效，输入过滤后按 Enter 提交。
17. **卡片三级展开**：卡片被折进 turn 进程组且组被 `hidden`。顺序：点所有文本含「用时」的披露 button → 点组标题 `O_Ebla_title`（DOM click 有效）→ 点卡片行 `[data-disclosure-row]`（role=button；外层 `.om-compaction-root` click 无效）。
18. **虚拟列表定位**：容器无原生滚动条，`scrollIntoView`/scrollTop 被重置（rect.y 恒为负）。用 CDP `mouseWheel` 循环把目标滚进视口（y 落在 120 ~ vh-160）再取坐标。
19. **effort 文本**：面板显示「模型默认/Low/Medium/High」，匹配用小写化 + endsWith，不要全等 'low'。
20. **配置表单入口**：设置弹窗的「内置插件」页不渲染 configForms；入口是侧边栏「插件」→ 插件管理器 → 已安装区行的 `button[aria-label="配置 <插件名>"]`。表单字段用原生 setter 触发 React 受控更新；「撤销修改」只回滚表单不写盘，验证时核对 patch 文件未变。
21. **截图取证**：整页截图可能因折叠裁剪看不到卡片，用元素矩形 clip 截图；截图与 DOM 断言互为佐证，DOM 是决定性证据。

## 环境（阶段 0）

22. **pnpm 忽略 build scripts**：profile 安装后 `onnxruntime-node`、`sharp` 等被 ignored，语义检索不可用。测试默认 `semanticRecallEnabled: false`；需要时 `pnpm approve-builds`。
23. **端口占用**：GUI 端口残留进程导致 `EADDRINUSE`、连锁多插件不激活。netstat 找 PID taskkill 后重启；启动日志出现 `did not activate` 先查端口。
