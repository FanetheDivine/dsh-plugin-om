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
| 精简度 | 5% | 参与候选中最短产物字符数 / 本候选字符数 |
| 模型耗时 | 5% | 参与候选中最快模型耗时 / 本候选模型耗时 |

判定标准见 [rules.md](references/rules.md)，计分由 `aggregate.ts` 完成。

## 约定

- 输入为本地会话 id 或 DSH 导出的 zip，未指明时向用户确认。zip 导出时需包含 subagents。
<!-- dev-only -->
- 源码版脚本是 TS，先在仓库根 `pnpm install`，再用 `node` 直接运行。
<!-- /dev-only -->
- 重压缩的模型与 effort 均先用 `ask_user_question` 向用户确认，多模型对比时逐个确认；effort 可缺省，缺省时用模型默认值。
- 盲评完成前不读 `_blind_key.json`，subagent 提示词中不写模型名。
- 所有文件写系统临时目录 `om-compaction-eval/`（Git Bash 即 `/tmp/om-compaction-eval/`）：view.json、重压缩目录、评估目录与自写临时脚本都在该目录下，不写工作区。重评同一区间前先删除旧评估目录。
- subagent 有并发上限，评审多时分批启动；subagent 失败时新开一个重做，不在原会话续发。

## 步骤

脚本目录 `S=<skill 目录>/scripts`，`<skill 目录>` 指本文件所在目录。`--session` 均可换成 `--zip`。区间标识为 `<会话 id 前 8 位>-<阶段>-<A>-<B>`。

### 1. 生成重压缩（可选）

```sh
node $S/view.ts --session <id>                                        # 列出已有压缩
node $S/view.ts --session <id> --compaction <压缩 id> [--out v.json]  # 复现某次压缩的输入
node $S/view.ts --session <id> --range A..B [--out v.json]            # 复现指定区间的输入
node $S/compress.ts v.json <provider/model[:effort]> [--out <重压缩目录>]
```

view 缺省输出 `view-<区间标识>.json`，compress 缺省输出 `recompress-<区间标识>/` 并在结束时打印目录路径；同一区间多次重压缩共用该目录，各占一条压缩日志。模型、凭据与是否省略 reasoning（`compressSkipReasoning`）读 DSH profile。多次运行或多模型对比由调用方循环，可后台并行。

### 2. 准备数据

```sh
node $S/prepare.ts --session <id> --list                              # 只列各区间候选与 token，不写目录
node $S/prepare.ts --session <id> [--variants <重压缩目录>]... [--range A..B] [--phase observe|reflect]
```

`--list` 用于按 token 用量挑区间，正式运行也会先打印同一列表。缺省选候选最多的区间，评估目录缺省 `eval-<区间标识>/`；目录已有 facts、评审或 parts 时报错，须先删除。产物含盲化候选 `V*.xml`、`source.xml`、`after.md`（区间终点之后的真实轨迹，只含用户消息、手动加载 skill、助手正文、工具调用与压缩标记）、含分段行号的 `rules.md` 等。

### 3. 构建事实清单

用 [facts-prompt.md](references/facts-prompt.md) 启动 1 个 subagent：把提示词中的 `<MERGE>` 替换为 `node $S/merge.ts facts <评估目录>` 后下发。subagent 分段写出 parts 文件并自行运行合并命令，主代理等 merge 成功后抽查 A 类事实与 `source.xml` 是否一致。

### 4. 盲评

用 [judge-prompt.md](references/judge-prompt.md) 为每个候选并行启动 2 名评审：`<MERGE>` 替换为 `node $S/merge.ts judge <评估目录> <V> <N>`。subagent 失败或超过并发上限时分批新开。

### 5. 汇总

```sh
node $S/aggregate.ts <评估目录> [--reference original|provider/model[:effort>]...
```

`--reference` 可重复：`original` 选原始压缩，其余按模型与可选 effort 匹配。参考候选照常算保留率与无关信息压缩，精简度与耗时按参与候选折算并封顶 100，单独成表，不参与排名与汇总。产出 `scores.json` 与 `scores.md`。修正 `facts.json` 后旧评审会因版本不符报错，须重新评审；对多数参与候选失败的 A 类事实回 `source.xml` 核实。

### 6. 汇报

排名表、关键发现与局限。
