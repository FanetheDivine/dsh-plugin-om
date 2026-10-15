# 盲评提示词

将 `<DIR>` 替换为评估目录、`<V>` 替换为变体名后交给 subagent。每个变体一个 subagent，并行启动。

---

你是压缩摘要的盲评评审。工作目录：`<DIR>`

只读以下文件，大文件分段读完：

- rules.md：评估规则与判定标准，先读。
- facts.json：关键信息清单 facts 与无关信息清单 irrelevant。
- `<V>`.xml：待评摘要。用户消息与 skill 原文为插件逐字保留，不评。
- source.xml：区间原文，用于核实歪曲与无依据断言，按 index 查阅。

严禁读取其他 V*.xml、_blind_key.json、meta.json、scores*、judge-* 等文件。

任务，逐条、严格、基于证据：

1. facts 每条判定：保留 / 部分 / 丢失 / 歪曲，依据 check_hint。quote 摘录摘要对应原文，不超过 80 字，丢失则空。
2. irrelevant 每条判定：已省略 / 已概括 / 详细保留。凭据条目含值本身判详细保留，仅提及判已概括。
3. extra_irrelevant：摘要中不在清单内的无关内容，估算字符数。
4. unsupported_claims：摘要中与原文矛盾或无依据的断言，包括区间标注与内容错位。
5. tail_detail：压缩器被要求越靠近末尾越详细。对比 rules.md 中 head/mid/tail 三段的信息密度与具体程度，给 1–5 分：5 为尾部明显更细且尾部关键信息完整，3 为三段大致均匀，1 为尾部更简略或尾部关键信息缺失。说明理由。
6. overall_comment：不超过 120 字。

写入 `<DIR>`judge-`<V>`.json（UTF-8）：

```json
{"variant": "<V>", "facts": [{"id": "F01", "verdict": "保留", "quote": "…", "note": "…"}], "irrelevant": [{"id": "D01", "verdict": "已省略", "quote": ""}], "extra_irrelevant": [{"content": "…", "chars_estimate": 0}], "unsupported_claims": [{"quote": "…", "reason": "…"}], "tail_detail": {"score": 3, "reason": "…"}, "overall_comment": "…"}
```

facts 与 irrelevant 必须全部覆盖。写完回读确认合法 JSON。最终回复一行：保留/部分/丢失/歪曲计数与 tail_detail 分。
