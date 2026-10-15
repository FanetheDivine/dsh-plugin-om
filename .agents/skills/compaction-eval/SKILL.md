---
name: compaction-eval
description: 评估、对比 OM 压缩质量
disable-model-invocation: true
---

# compaction-eval

同一压缩区间的多个变体，即原始压缩与重压缩，用 subagent 盲评打分。

## 评分维度

- 关键信息保留 50%：事实按 A 不可再生 3、B 高代价可再生 2、C 廉价可再生 1 加权；保留 1、部分 0.5、丢失 0、歪曲 −1。
- 尾部详略 20%：评审 tail_detail 分与 tail 段保留率各半。
- 无关信息压缩 15%：已省略 1、已概括 0.7、详细保留 0。凭据出现单独标出。
- 总时间 15%：最快变体耗时 / 本变体耗时。

结构合法性由插件代码保证，不评。

## 步骤

### 1. 确定会话与区间

- 主会话日志位于 `~/.dsh/sessions/<工作区>/<会话 id>/session.v4.jsonl.zstd`，压缩日志为同目录下 `om-compaction-log-*`，parentSession 指向主会话。
- 用户未指明会话时，用 `ask_user_question` 确认。
- 脚本用 Node 直接运行 TS，依赖已在项目 devDependencies 中，先 `pnpm install`。

### 2. 准备数据

```sh
node .agents/skills/compaction-eval/scripts/prepare.ts --session <会话 id 或前缀> [--range A..B] [--out 目录]
```

- 列出各区间的变体，缺省选变体最多的区间。只有 1 个变体时也可评，但不做对比。
- 输出目录缺省为 `<工作区>/.session-snapshots/eval-<会话>-<A>-<B>/`。
- 产出：盲化变体 `V*.xml`、原文 `source.xml`、后续轨迹 `after.md`、规则 `rules.md`、映射 `_blind_key.json`、`meta.json`。
- 盲评完成前不要读 `_blind_key.json`，也不要把模型名写进 subagent 提示词。

### 3. 构建事实清单

- 用 [facts-prompt.md](references/facts-prompt.md) 启动一个 subagent，产出 `facts.json`。
- 抽查 A 类事实与 source.xml 是否一致，不合理就让 subagent 修正。

### 4. 盲评

- 用 [judge-prompt.md](references/judge-prompt.md) 为每个变体启动一个 subagent，在同一条消息中并行启动，产出 `judge-V*.json`。
- 校验每份 judge 都覆盖了全部 facts 与 irrelevant。

### 5. 汇总

```sh
node .agents/skills/compaction-eval/scripts/aggregate.ts <评估目录>
```

- 产出 `scores.json` 与 `scores.md`。
- 对"过半变体失败的 A 类事实"逐条回 source.xml 核实，区分压缩器共性缺陷与清单或评审错误；评审错误则修正 judge 后重跑。

### 6. 汇报

- 排名表：模型、综合分、保留、A 类、尾部、无关压缩、耗时、token。
- 关键发现：区分度来源、共性失败及原因、尾部是否真正更细、凭据泄漏。
- 建议：质量优先与速度优先的组合，可改进的压缩提示词点。
- 局限：单次运行、单区间、权重未经下游校准。建议每个组合重压缩 2–3 次估方差。
