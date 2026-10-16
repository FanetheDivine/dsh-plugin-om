# Changelog

## Changes

- 裸调用 `/om-compaction-eval` 时弹出与 `/model` 同源的模型面板：按供应商分组、可模糊搜索，加载失败的供应商只展示不可选；选中后提交 `/om-compaction-eval <provider>/<model>`（不带思考等级）并跳转到新会话。带参数调用仍由宿主直接执行；`commandUi`、`modelDirectories` 或 `remote.commands` 缺失时不挂面板，命令退回手敲参数。
- `/om-compaction-eval` 新增可选参数 `provider/model [思考等级]`：新会话默认沿用当前会话最近一次请求的 provider、model 与思考等级，参数可覆盖，只给模型时思考等级用模型默认；模型在投递首条消息前选定，被宿主拒绝时返回原因且不投递。
- compaction-eval 文档统一称原始压缩与重压缩为“候选”，不再把原始压缩叫“变体”；重压缩前须先向用户确认模型与 effort。
- 新增 `/om-compaction-eval` 命令：在被分析会话所属工作区新建会话，投递首条消息让新会话按评估文档分析该会话的 OM 压缩结果，浏览器监听到命令成功后自动跳转。命令无参数，仅主会话可用，宿主缺 `sessionController` 或会话无 `cwd` 时返回原因；与重压缩命令一样依赖 `commands` 服务，缺失时一并停用并输出 warning。
- compaction-eval skill 随 npm 包发布到 `dist/skill/compaction-eval`：四个脚本打成自包含 `.mjs`，只把宿主提供的 `@deepseek-ai/*` 与 `zod` 留作外部依赖，`fflate`、`fzstd`、`yaml` 与插件源码全部内联；SKILL.md 构建时渲染为发布版，脚本名改 `.mjs`、源码版说明删除。用户环境运行脚本不需要 `pnpm install`。
- 修复 OM 压缩后 Claude 请求偶发 400 `Invalid signature in thinking block`：新增前置 `llm/stream` 中间件，以表层最后一条 OM 消息为分界，剥离其后生成于压缩前的 assistant 消息中的 Anthropic 签名 reasoning 与 `replayState`，仅匹配 Anthropic 协议且模型名含 `claude-` 的消息，其他模型不受影响。
- 服务端只强依赖 `llm` 和 `tokenMeter`：`tools` 缺失时不注册 `recall`，`sessions` 缺失时跳过压缩会话记录落盘，`commands` 缺失时不注册重压缩命令，三者缺失都只输出 warning，压缩与日志替换照常运行；新增只挂载 `llm` 和 `tokenMeter` 的集成测试。
- 手动加载的 skill（`skill-invocation` 系统消息）重新计入完整消息：占 index，recall 输出 `<skill_content>`，压缩视图与工具加载的 skill 一致保留原文；其余系统消息仍不占 index。
- compaction-eval 的 SKILL.md 只保留主流程，评分维度只在一处说明，规则与提示词不再重复判定和计分；脚本直接用 `node` 运行。
- compaction-eval 可自行生成变体：`view.ts` 列出会话已有压缩，按压缩 id 或完整消息区间复现压缩输入视图；`compress.ts` 读 DSH profile 的模型与凭据直连模型跑压缩，产出重压缩日志且不改原会话；`prepare.ts --variants` 并入这些日志。重复次数与模型、思考等级组合由调用方组合脚本实现。
- compaction-eval 的 SKILL.md、规则与评审提示词按输入、任务、输出重新组织，语言更简洁。
- 新增 compaction-eval skill：读取本地会话或 DSH 导出的会话日志 zip，对同一区间的压缩与重压缩变体做 subagent 盲评，按关键信息保留 70%、无关信息压缩 20%、精简度 5%、模型耗时 5% 打分，保留率按不可再生信息加权；每变体两名评审取均值，同模型多变体输出综合分均值与标准差。
- agent-workflow 创建 worktree 前先 fetch 最新的 `origin/main`。
- 重压缩菜单支持多选模型和思考等级，一次提交按组合并行重压缩，并发上限由 `recompressConcurrency` 配置（默认 `2`）。
- 压缩提示词按后续用途分配摘要粒度，不再按位置越往后越细：未完成任务与当前状态保留细节，已完成子任务只留结果与决策，不可再生信息不论早晚都保留；反思额外要求合并已有摘要时不丢失不可再生信息。
