---
name: compaction-eval
description: 评估、对比 OM 压缩质量
disable-model-invocation: true
---

# compaction-eval

对同一压缩区间的多个候选盲评打分。候选包括会话中的原始压缩与本 skill 生成的重压缩，评审时统一编号为 `V*`。

## 评分

| 维度 | 权重 | 计分 |
| --- | --- | --- |
| 关键信息保留 | 70% | 按 A/B/C 类加权的事实保留率，无依据断言扣分 |
| 无关信息压缩 | 20% | 无关信息的省略程度 |
| 精简度 | 5% | 最短产物字符数 / 本候选字符数 |
| 模型耗时 | 5% | 最快模型耗时 / 本候选模型耗时 |

判定标准见 [rules.md](references/rules.md)，计分由 `aggregate.ts` 完成。

## 约定

- 输入为本地会话 id 或 DSH 导出的 zip，未指明时向用户确认。zip 导出时需包含 subagents。
<!-- dev-only -->
- 源码版脚本是 TS，先在仓库根 `pnpm install`，再用 `node` 直接运行。
<!-- /dev-only -->
- 重压缩的模型与 effort 均先用 `ask_user_question` 向用户确认，多模型对比时逐个确认；effort 可缺省，缺省时用模型默认值。
- 盲评完成前不读 `_blind_key.json`，subagent 提示词中不写模型名。

## 步骤

脚本目录 `S=<skill 目录>/scripts`，`<skill 目录>` 指本文件所在目录。`--session` 均可换成 `--zip`。

### 1. 生成重压缩（可选）

需要重压缩时执行：

```sh
node $S/view.ts --session <id>                                       # 列出已有压缩
node $S/view.ts --session <id> --compaction <压缩 id> --out v.json    # 复现某次压缩的输入
node $S/view.ts --session <id> --range A..B --out v.json             # 复现指定区间的输入
node $S/compress.ts v.json <provider/model[:effort]> --out <重压缩目录> # 跑一次重压缩
```

模型与凭据读 DSH profile。多次运行或多模型对比由调用方循环，可后台并行。

### 2. 准备数据

```sh
node $S/prepare.ts --session <id> [--variants <重压缩目录>]... [--range A..B] [--phase observe|reflect]
```

缺省选候选最多的区间，产出评估目录，含盲化候选 `V*.xml`、`source.xml`、`after.md`、`rules.md` 等。

### 3. 构建事实清单

用 [facts-prompt.md](references/facts-prompt.md) 启动 1 个 subagent 产出 `facts.json`，抽查 A 类事实与 `source.xml` 是否一致。

### 4. 盲评

用 [judge-prompt.md](references/judge-prompt.md) 为每个候选并行启动 2 名评审。

### 5. 汇总

```sh
node $S/aggregate.ts <评估目录>
```

产出 `scores.json` 与 `scores.md`。对多数候选失败的 A 类事实回 `source.xml` 核实：清单有误则修正后重评，评审有误则修正 judge 文件后重新汇总。

### 6. 汇报

排名表、关键发现、改进建议与局限。
