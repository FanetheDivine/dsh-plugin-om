# 盲评提示词

将 `<DIR>` 替换为评估目录、`<V>` 替换为变体名、`<N>` 替换为评审序号后交给 subagent。每个变体两名评审，全部并行启动，互相不可见。

---

你是压缩摘要的盲评评审。工作目录：`<DIR>`

只读以下文件，大文件分段读完：

- rules.md：评估规则与判定标准，先读。
- facts.json：关键信息清单 facts 与无关信息清单 irrelevant。
- `<V>`.xml：待评摘要。用户消息与 skill 原文为插件逐字保留，不评。
- source.xml：压缩输入视图，用于核实歪曲与无依据断言，按 index 查阅。

严禁读取其他 V*.xml、_blind_key.json、meta.json、scores*、judge-* 等文件。

任务，逐条、严格、基于证据：

1. facts 每条判定：保留 / 部分 / 丢失 / 歪曲，依据 check_hint。quote 摘录摘要对应原文，不超过 80 字，丢失则空。
2. irrelevant 每条判定：已省略 / 已概括 / 详细保留。凭据条目含值本身判详细保留，仅提及判已概括。
3. extra_irrelevant：摘要中不在清单内的无关内容，估算字符数。
4. unsupported_claims：摘要中与原文矛盾或无依据的断言，包括区间标注与内容错位。每条会扣分，只列确有依据的。
5. overall_comment：不超过 120 字。

写入 `<DIR>`judge-`<V>`-`<N>`.json（UTF-8）：

```json
{"variant": "<V>", "facts": [{"id": "F01", "verdict": "保留", "quote": "…", "note": "…"}], "irrelevant": [{"id": "D01", "verdict": "已省略", "quote": ""}], "extra_irrelevant": [{"content": "…", "chars_estimate": 0}], "unsupported_claims": [{"quote": "…", "reason": "…"}], "overall_comment": "…"}
```

facts 与 irrelevant 必须全部覆盖。写完回读确认合法 JSON。最终回复一行：保留/部分/丢失/歪曲计数与无依据断言数。
