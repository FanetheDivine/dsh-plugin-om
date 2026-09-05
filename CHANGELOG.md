# Changelog

## Unreleased

### Added

- 机制说明与成本计算器站点（`web/`，独立 Vite + React 工程，发布到 GitHub Pages，不随插件包分发）：om 机制讲解、dsh 注入消息（AGENTS.md / skill 定义等）及其压缩后 `<sys>` 空条目遮蔽说明、可调参数（系统提示词 / dsh 注入 / 观察阈值 / 反思阈值 / 压缩比 / 步长 / 三类 token 价格）驱动的 20k–250k 原始会话规模成本对比表（om 开/关三类 token 消耗、费用与节省额）
- 成本模型纯函数 `web/src/model.ts`（om 开/关全会话模拟：前缀缓存计费、观察/反思触发、注入遮蔽、压缩轮缓存截断、摘要调用按缓存创建计价）及 `tests/web/model.test.ts` 覆盖
- `web-deploy.yml` workflow：`web/**` 变更合入 main 时构建并部署 GitHub Pages（需在仓库 Settings → Pages 选择 GitHub Actions 作为 Source）
- README 配置一节引用站点地址

### Changed

- 观察压缩改为延迟执行：净压力首次达到观察阈值时记录待定标记（log-only `om/observe-pending` 事件，触发点 = 当时的最后一条完整消息 index）本次不压缩；待定后新增完整消息数达到 `tailMessageCount` 才把压缩边界至触发点的全部内容摘要为新 `<history>` 块（等待期消息成为新的未压缩尾部；`tailMessageCount=0` 保持触发当轮立即执行）。待定标记持久化在会话日志中（重启后从日志恢复），摘要失败保留待定、下个 pre-step 直接重试，执行成功后写 `om/observe-invalidate` 失效标记
- `pnpm-workspace.yaml` 新增 `web` 包与 `esbuild` 构建白名单（web 构建依赖）
- `web/` 成本计算器 UI 重构为 Tailwind CSS + shadcn/ui：左侧参数侧边栏（滑块 + 数字输入联动）、右侧合并单元格成本表（每格显示 om 关闭红 / om 开启绿两个值）
- `web/` 参数数字输入支持任意非负值（不受滑块最小值钳制），编辑期间可清空、失焦回落到受控值；模型对每轮新增 Δ ≤ 0 返回 0 轮、表格步长按 1000 下限执行（行数防护）
- 调整压缩提示词
- 调整skill