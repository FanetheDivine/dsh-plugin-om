# 盲评提示词

将 `<DIR>` 替换为评估目录、`<V>` 替换为变体名、`<N>` 替换为评审序号后交给 subagent。

---

你是压缩摘要的盲评评审。工作目录：`<DIR>`

## 输入

1. `rules.md`：评估规则与判定标准，先读。
2. `facts.json`：关键信息清单 `facts` 与无关信息清单 `irrelevant`。
3. `<V>.xml`：待评摘要。
4. `source.xml`：压缩输入，用于核实。

不读其他变体、`_blind_key.json`、`meta.json` 及评分结果。

## 任务

按 `rules.md` 逐条判定，基于证据：

1. `facts`：依据 `check_hint` 判定，`quote` 摘录摘要中的对应原文。
2. `irrelevant`：判定省略程度。
3. `extra_irrelevant`：清单外的无关内容，估算字符数。
4. `unsupported_claims`：与原文矛盾或无依据的断言，包括区间标注与内容错位。
5. `overall_comment`：简短总评。

## 输出

写入 `<DIR>/judge-<V>-<N>.json`：

```json
{
  "variant": "<V>",
  "facts": [{ "id": "F01", "verdict": "保留", "quote": "…", "note": "…" }],
  "irrelevant": [{ "id": "D01", "verdict": "已省略", "quote": "" }],
  "extra_irrelevant": [{ "content": "…", "chars_estimate": 0 }],
  "unsupported_claims": [{ "quote": "…", "reason": "…" }],
  "overall_comment": "…"
}
```

`facts` 与 `irrelevant` 须全部覆盖。最终回复各判定的计数。
