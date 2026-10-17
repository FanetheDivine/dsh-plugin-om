# 用例推导方法与示例

功能持续变化，用例不写死。每轮实机测试按本方法现场推导。

## 推导方法

1. **列交互面**：`git log <上个tag>..HEAD --oneline` + CHANGELOG 逐条过。对每个 commit 判断是否触碰宿主交互面：
   - 会话事件读写（append、surfaceOp、feedback/record 信封）
   - turn 生命周期（pre-step 拦截、whenIdle、reason blocked）
   - 宿主服务（llm.stream、tokenMeter、sessions、sessionPersistence、commands、sessionController）
   - 持久化与重启（冷启动采纳、诊断子会话落盘）
   - 前端契约（插槽、chat node、命令 UI、配置表单、locale）
2. **设计 mock 脚本**：每个交互面对应 mock-provider 的一个 mode 或轮次脚本——哪轮发什么工具调用、注入什么错误、返回什么 usage。
3. **事件级断言**：以会话落盘 jsonl 为事实源写断言。覆盖成功路径、失败路径、原子性三态。
4. **冷重启拆分**：需要跨进程验证的（持久化采纳），warm 播种 + 独立 cold 驱动。
5. **前端映射**：每个用户可见 UI 元素一条浏览器流程，DOM 断言 + 截图双证据。

## 示例：0.0.56 后一轮的映射（后端 20 例）

| 用例 | commit | mock mode | 断言事实源 |
|---|---|---|---|
| 装载 + dist 一致性 | — | — | fiber.assertActive、commands.list、requestHeader().tools、sha256 |
| 立即观察 + 记录 seed + label | #111 #108 #112 | normal | compaction/start(phase=observe)、om:1: 信封、subagent/catalog label、诊断子会话 seed |
| 后台预压缩 + 延迟注入 | #111 | normal, tailMessageCount=3 | observe-summary 先于注入、到期轮 compCalls=0、注入后 history 块 |
| 冷启动采纳 | #111 | normal（cold 驱动） | 重启后 pending/summary 仍在、注入零重压缩、diagnosticSessionId 复用 |
| 阈值真实 token 换算 | #109 | usageMultiplier 1/8 | 低倍数不触发、高倍数触发 observe-pending |
| 截断重试后成功 | #113 | truncate-recover | 5 次请求 = 2 截断 + 3 正常、截断输出不回流、提醒文本 |
| 截断失败原子性 | #113 | truncate-always | 普通请求 0、turn/end blocked、表层不变、label「-失败」 |
| 瞬时/5xx 重试 | #109 | transient-recover, 5xx-recover | 4 次请求后成功 |
| getHistory 当前状态 | #110 | state-check | 第二次视图含已提交摘要、不含已替换原文 |
| toolcall 无 callId | #107 | RECALL_CASE | 视图 `<assistant type="toolcall">` 含 tool-args/tool-result、无 callId |
| compressSkipReasoning | #105 | REASON_CASE | 开：视图无 reasoning；关：保留 |
| Claude 签名思考剥离 | #101 | claude-mock + replayState | 陈旧签名 reasoning 被剥离、新签名保留 |
| 无签名 reasoning 对照 | #101 | mock-model | 宿主回放行为如实断言（先 dump 再定向） |
| 反思合并 | #112 #94 | normal | phase=reflect、多块合一、label「-反思」 |
| 重压缩命令矩阵 | #94 | claude-mock(low) | 用法错误、未找到、未成功、成功文本、并发限流、主会话不变 |
| 评估命令 | #102 #104 #106 | — | 用法错误、启动分析会话、prompt 含 SKILL.md 路径与 session_id、模型选择 |
| ask 重写回归 | 基线 | rewrite | rewriteAskUserQuestion 守卫错误文案、TOOL_NOT_STARTED、特殊字面值保真 |
| 手动 skill 计数 | #99 | 手工 append skill-invocation | 视图 skill_content 条目、index 正确 |

## 示例：前端 6 流程

| 流程 | 断言 |
|---|---|
| 新建会话冒烟 | mock 回复气泡、轮次统计、client combo URL 200 |
| 压缩卡片 | 三级展开后摘要行文本（字符 A → B、耗时、provider/model）、展开体 history 摘要、actions 三项 |
| 换模型重压缩 | 菜单模型列表、effort 选择、提交后出现「重压缩完成」新记录 |
| 评估面板 | 真实键击 `/` 唤起 palette、Enter 进面板、选模型与 effort、提交跳转新会话且 composer 绑定所选模型 |
| 配置面板 | 列表卡片「查看」进详情页、组件行「配置」进表单、字段标签与 `src/config.ts` 的 volatile 字段一致、编辑触发「撤销修改」、撤销恢复且不写盘 |
| 诊断日志 | 搜索标题打开会话、三级展开卡片、点「诊断日志」打开诊断子会话 |

## 报告结构

```
# OM 实机测试报告 <版本> <commit>
## 环境（宿主版本、profile、mock、Chrome）
## 后端用例表（用例 | commit | 结果 | 关键断言）
## 浏览器流程表（流程 | 结果 | 截图）
## 发现与瑕疵（缺陷记此处，不改插件代码）
## 产物清单（results json、日志、截图路径）
```
