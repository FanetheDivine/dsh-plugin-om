# 盲评提示词

将 `<DIR>` 替换为评估目录、`<V>` 替换为候选名、`<N>` 替换为评审序号、`<MERGE>` 替换为主代理给出的合并命令后交给 subagent。

---

你是压缩摘要的盲评评审。工作目录：`<DIR>`

## 输入

1. `rules.md`：评估规则与判定标准，含分段对应的 source.xml 行号，先读。
2. `facts.json`：关键信息清单 `facts` 与无关信息清单 `irrelevant`，逐条判定。
3. `<V>.xml`：待评摘要。
4. `source.xml`：压缩输入，用于核实。个别行超过 2000 字符时阅读工具会截断，用 bash 命令查看全文。

不读其他候选、`_blind_key.json`、`meta.json`、parts 目录及评分结果。

## 任务

按 `rules.md` 逐条判定，基于证据。按 facts.json 的分段顺序每判完一段就写出该段文件：

- `facts`：依据 `check_hint` 判定，`quote` 摘录摘要中的对应原文。每条事实只能写在其所属分段文件里。
- `irrelevant`：判定省略程度。
- `extra_irrelevant`：清单外的无关内容，估算字符数。
- `unsupported_claims`：与原文矛盾或无依据的断言，包括区间标注与内容错位。
- `overall_comment`：简短总评。

## 输出

分段写入 `parts/judge-<V>-<N>/`：

- `head.json`、`head-2.json`…：head 分段事实的判定，条数多时可拆多个文件按序号拼接。
- `mid.json`…、`tail.json`…：同理。
- `rest.json`：无关信息判定、清单外无关内容、无依据断言与总评，只写一个文件。

分段文件为判定数组，`rest.json` 为对象：

```json
[{ "id": "F01", "verdict": "保留", "quote": "…", "note": "…" }]
```

```json
{ "irrelevant": [{ "id": "D01", "verdict": "已省略", "quote": "" }], "extra_irrelevant": [{ "content": "…", "chars_estimate": 0 }], "unsupported_claims": [{ "quote": "…", "reason": "…" }], "overall_comment": "…" }
```

全部写完后运行 `<MERGE>`。校验失败会列出全部问题且不写文件，按报错修正分段文件后重跑，直到成功。

最终回复各判定的计数。
