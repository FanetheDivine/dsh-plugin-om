---
name: compaction-eval
description: 评估、对比 OM 压缩质量
disable-model-invocation: true
---

# compaction-eval

同一压缩区间的多个变体，即原始压缩与重压缩，用 subagent 盲评打分。

## 评分维度

- 关键信息保留 50%：事实按 A 不可再生 3、B 高代价可再生 2、C 廉价可再生 1 加权；保留 1、部分 0.5、丢失 0、歪曲 −1；每条无依据断言从分子扣 2 分。
- 精简度 20%：最小产物字符数 / 本变体产物字符数，防止几乎不压缩的变体拿高分。
- 无关信息压缩 15%：已省略 1、已概括 0.7、详细保留 0。凭据出现单独标出。
- 模型耗时 15%：最快模型耗时 / 本变体模型耗时，只计模型请求，不含限流等待。

分段保留率、分段压缩率、清单外无关内容数量与评审分歧只作诊断输出，不计分。结构合法性由插件代码保证，不评。

## 步骤

### 1. 确定会话与区间

- 主会话日志位于 `~/.dsh/sessions/<工作区>/<会话 id>/session.v4.jsonl.zstd`，压缩日志为同目录下 `om-compaction-log-*`，parentSession 指向主会话。
- 变体按阶段与区间分组，同区间同时有观察与反思日志时必须用 `--phase` 指定。
- 用户未指明会话时，用 `ask_user_question` 确认。
- 脚本用 Node 直接运行 TS，依赖已在项目 devDependencies 中，先 `pnpm install`。

### 2. 准备数据

```sh
node .agents/skills/compaction-eval/scripts/prepare.ts --session <会话 id 或前缀> [--range A..B] [--phase observe|reflect] [--out 目录]
```

- 列出各分组的变体，缺省选变体最多的分组。只有 1 个变体时也可评，但不做对比。
- 输出目录缺省为 `<工作区>/.session-snapshots/eval-<会话>-<阶段>-<A>-<B>/`。
- 产出：盲化变体 `V*.xml`、压缩输入 `source.xml`、后续轨迹 `after.md`、规则 `rules.md`、映射 `_blind_key.json`、`meta.json`。
- 盲评完成前不要读 `_blind_key.json`，也不要把模型名写进 subagent 提示词。

### 3. 构建事实清单

- 用 [facts-prompt.md](references/facts-prompt.md) 启动一个 subagent，产出 `facts.json`。
- 抽查 A 类事实与 source.xml 是否一致，不合理就让 subagent 修正。

### 4. 盲评

- 用 [judge-prompt.md](references/judge-prompt.md) 为每个变体启动两名评审 subagent，全部在同一条消息中并行启动，产出 `judge-V*-1.json` 与 `judge-V*-2.json`。
- 汇总脚本会校验评审文件齐全、facts 与 irrelevant 全覆盖、判定词合法，不合法直接报错。

### 5. 汇总

```sh
node .agents/skills/compaction-eval/scripts/aggregate.ts <评估目录>
```

- 产出 `scores.json` 与 `scores.md`，两名评审的判定取均值，分歧条目列入 scores.md。
- 对"过半变体失败的 A 类事实"逐条回 source.xml 核实，区分压缩器共性缺陷与清单或评审错误。
- 清单有误：修正 facts.json 后重跑全部评审再汇总。评审错误：修正对应 judge 文件后重跑汇总。
- 同模型同思考等级有多个变体时，scores.md 附综合分均值与标准差。

### 6. 汇报

- 排名表：模型、综合分、保留、精简、无关压缩、耗时、A 类、无依据断言、token。
- 关键发现：区分度来源、共性失败及原因、无依据断言、评审分歧、凭据泄漏。
- 建议：质量优先与速度优先的组合，可改进的压缩提示词点。
- 局限：单次运行、单区间、权重未经下游校准；after.md 是原始摘要下的真实轨迹，对重压缩变体只能作近似参照。建议每个组合重压缩 2–3 次，用均值与标准差估方差。
