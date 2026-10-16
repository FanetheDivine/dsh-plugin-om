---
name: compaction-eval
description: 评估、对比 OM 压缩质量
disable-model-invocation: true
---

# compaction-eval

对同一压缩区间的多个变体盲评打分。变体包括原始压缩与重压缩。

## 评分

| 维度 | 权重 | 计分 |
| --- | --- | --- |
| 关键信息保留 | 70% | 按 A/B/C 类加权的事实保留率，无依据断言扣分 |
| 无关信息压缩 | 20% | 无关信息的省略程度 |
| 精简度 | 5% | 最短产物字符数 / 本变体字符数 |
| 模型耗时 | 5% | 最快模型耗时 / 本变体模型耗时 |

判定标准见 [rules.md](references/rules.md)，计分由 `aggregate.ts` 完成。

## 约定

- 输入为本地会话 id 或 DSH 导出的 zip，未指明时向用户确认。zip 导出时需包含 subagents。
- 先 `pnpm install`，脚本用 `node` 直接运行。
- 盲评完成前不读 `_blind_key.json`，subagent 提示词中不写模型名。

## 步骤

脚本目录 `S=.agents/skills/compaction-eval/scripts`，`--session` 均可换成 `--zip`。

### 1. 生成变体（可选）

需要重压缩时执行：

```sh
node $S/view.ts --session <id>                                       # 列出已有压缩
node $S/view.ts --session <id> --compaction <压缩 id> --out v.json    # 复现某次压缩的输入
node $S/view.ts --session <id> --range A..B --out v.json             # 复现指定区间的输入
node $S/compress.ts v.json <provider/model[:effort]> --out <变体目录> # 跑一次重压缩
```

模型与凭据读 DSH profile。多次运行或多模型对比由调用方循环，可后台并行。

### 2. 准备数据

```sh
node $S/prepare.ts --session <id> [--variants <变体目录>]... [--range A..B] [--phase observe|reflect]
```

缺省选变体最多的区间，产出评估目录，含盲化变体 `V*.xml`、`source.xml`、`after.md`、`rules.md` 等。

### 3. 构建事实清单

用 [facts-prompt.md](references/facts-prompt.md) 启动 1 个 subagent 产出 `facts.json`，抽查 A 类事实与 `source.xml` 是否一致。

### 4. 盲评

用 [judge-prompt.md](references/judge-prompt.md) 为每个变体并行启动 2 名评审。

### 5. 汇总

```sh
node $S/aggregate.ts <评估目录>
```

产出 `scores.json` 与 `scores.md`。对多数变体失败的 A 类事实回 `source.xml` 核实：清单有误则修正后重评，评审有误则修正 judge 文件后重新汇总。

### 6. 汇报

排名表、关键发现、改进建议与局限。
