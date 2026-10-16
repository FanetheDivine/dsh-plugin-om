---
name: compaction-eval
description: 评估、对比 OM 压缩质量
disable-model-invocation: true
---

# compaction-eval

对同一压缩区间的多个变体盲评打分。变体包括原始压缩与重压缩，重压缩可在 DSH 中触发，或由脚本生成。

## 评分

| 维度 | 权重 | 计分 |
| --- | --- | --- |
| 关键信息保留 | 70% | 事实权重 A 3、B 2、C 1；保留 1、部分 0.5、丢失 0、歪曲 −1；每条无依据断言从分子扣 2 分 |
| 无关信息压缩 | 20% | 已省略 1、已概括 0.7、详细保留 0；凭据单独标出 |
| 精简度 | 5% | 最小产物字符数 / 本变体产物字符数，防止几乎不压缩的变体拿高分 |
| 模型耗时 | 5% | 最快模型耗时 / 本变体模型耗时，只计模型请求，不含限流等待 |

- 只诊断不计分：分段保留率、分段压缩率、清单外无关内容、评审分歧。
- 不评结构合法性，由插件代码保证。

## 约定

- 用户给出 DSH 导出的 zip 时直接用；未指明会话时用 `ask_user_question` 确认。
- 脚本用 Node 直接运行 TS，先 `pnpm install`。`view.ts` 与 `compress.ts` 引用插件源码，需加 `--experimental-transform-types`。
- 盲评完成前不读 `_blind_key.json`，subagent 提示词中不写模型名。

## 输入

- 本地会话：主会话为 `~/.dsh/sessions/<工作区>/<会话 id>/session.v4.jsonl.zstd`，同目录 `om-compaction-log-*` 为压缩日志，parentSession 指向主会话。
- 导出 zip：根部 `session.v4.jsonl` 为主会话，`subagents/om-compaction-log-*/` 为压缩日志。导出时需包含 subagents。

## 步骤

### 1. 生成变体（可选）

用户要求为已有压缩或指定区间生成变体时执行。脚本各做一件事，由调用方组合。

```sh
S=.agents/skills/compaction-eval/scripts
N="node --experimental-transform-types --no-warnings"
$N $S/view.ts --session <id>                                    # 列出已有压缩：id、阶段、区间、成败、模型
$N $S/view.ts --session <id> --compaction <压缩 id> --out v.json # 复现该次压缩的输入
$N $S/view.ts --session <id> --range A..B --out v.json          # 复现 B 结束时插件看到的区间视图
$N $S/compress.ts v.json <provider/model[:effort]> --out <变体目录>
```

- `view.ts`：`--session` 可换成 `--zip`。
- `--range`：A..B 为完整消息 index。块外取原文，块内取相交的摘要条目；含摘要条目为反思，否则为观察。区间按实际条目扩展。
- `compress.ts`：每次跑一个变体，打印一行结果，失败时退出码非 0。重复次数与模型、思考等级组合由调用方循环，可后台并行。
- 配置：模型与插件配置读 `~/.dsh/profiles/<DSH_PROFILE 或 web>/cordis.patch.yml`。凭据依次取环境变量、Windows 用户环境变量、`~/.dsh/.credentials.yaml`、`.env`。
- 产出：与 DSH 同格式的 `om-compaction-log-*` 日志，标记为重压缩，不改原会话。

### 2. 准备数据

```sh
node .agents/skills/compaction-eval/scripts/prepare.ts (--session <会话 id 或前缀> | --zip <zip 路径>) [--variants <变体目录>]... [--range A..B] [--phase observe|reflect] [--out 目录]
```

- 分组：变体按阶段与区间分组，缺省选变体最多的组。同区间同时有观察与反思日志时，用 `--phase` 指定。只有 1 个变体也可评，但不做对比。
- `--variants`：可重复，并入第 1 步产出的日志。
- 输出目录：`eval-<会话 id 前 8 位>-<阶段>-<A>-<B>`。本地会话缺省放在 `<工作区>/.session-snapshots/` 下，zip 缺省放在 `<zip 所在目录>/<zip 名>/` 下。
- 产出：
  - `V*.xml`：盲化变体
  - `source.xml`：压缩输入
  - `after.md`：后续轨迹
  - `rules.md`：评估规则
  - `_blind_key.json`：变体与模型的映射
  - `meta.json`：元数据

### 3. 构建事实清单

- 用 [facts-prompt.md](references/facts-prompt.md) 启动 1 个 subagent，产出 `facts.json`。
- 抽查 A 类事实与 `source.xml` 是否一致，有误让 subagent 修正。

### 4. 盲评

- 用 [judge-prompt.md](references/judge-prompt.md) 为每个变体启动 2 名评审，全部在同一条消息中并行启动。
- 产出 `judge-V*-1.json` 与 `judge-V*-2.json`。

### 5. 汇总

```sh
node .agents/skills/compaction-eval/scripts/aggregate.ts <评估目录>
```

- 校验：评审文件齐全、facts 与 irrelevant 全覆盖、判定词合法，否则直接报错。
- 产出：`scores.json` 与 `scores.md`。两名评审的判定取均值，分歧条目列入 `scores.md`；同模型同思考等级有多个变体时，附综合分均值与标准差。
- 核实：对过半变体失败的 A 类事实，逐条回 `source.xml` 核实，区分压缩器共性缺陷与清单或评审错误。
- 纠错：
  - 清单有误：修正 `facts.json`，重跑全部评审后再汇总。
  - 评审有误：修正对应 judge 文件，重跑汇总。

### 6. 汇报

- 排名表：模型、综合分、保留、精简、无关压缩、耗时、A 类、无依据断言、token。
- 关键发现：区分度来源、共性失败及原因、无依据断言、评审分歧、凭据泄漏。
- 建议：质量优先与速度优先的组合，压缩提示词的改进点。
- 局限：
  - 单次运行、单区间，权重未经下游校准。
  - `after.md` 是原始摘要下的真实轨迹，对重压缩变体只是近似参照。
  - 建议每个组合用第 1 步生成 2–3 次，用均值与标准差估方差。
