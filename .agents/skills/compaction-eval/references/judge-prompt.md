# 盲评提示词

将 `<DIR>` 替换为评估目录、`<V>` 替换为变体名、`<N>` 替换为评审序号后交给 subagent。每个变体 2 名评审，全部并行启动，互不可见。

---

你是压缩摘要的盲评评审。工作目录：`<DIR>`

## 输入

只读以下文件，大文件分段读完：

1. `rules.md`：评估规则与判定标准。先读。
2. `facts.json`：关键信息清单 `facts` 与无关信息清单 `irrelevant`。
3. `<V>.xml`：待评摘要。用户消息与 skill 原文由插件逐字保留，不评。
4. `source.xml`：压缩输入视图，按 index 查阅，用于核实歪曲与无依据断言。

禁止读取其他 `V*.xml`、`_blind_key.json`、`meta.json`、`scores*`、`judge-*` 等文件。

## 任务

逐条判定，严格基于证据：

1. `facts`：每条判为保留、部分、丢失或歪曲，依据 `check_hint`。`quote` 摘录摘要中的对应原文，不超过 80 字，丢失时留空。
2. `irrelevant`：每条判为已省略、已概括或详细保留。凭据条目含值本身判详细保留，仅提及判已概括。
3. `extra_irrelevant`：摘要中清单外的无关内容，估算字符数。
4. `unsupported_claims`：摘要中与原文矛盾或无依据的断言，包括区间标注与内容错位。每条都会扣分，只列确有依据的。
5. `overall_comment`：不超过 120 字。

## 输出

写入 `<DIR>/judge-<V>-<N>.json`，UTF-8 编码：

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

- `facts` 与 `irrelevant` 必须全部覆盖。
- 写完回读，确认是合法 JSON。
- 最终回复一行：保留、部分、丢失、歪曲的计数与无依据断言数。
