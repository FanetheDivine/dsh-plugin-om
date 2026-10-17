# 事实清单提示词

将 `<DIR>` 替换为评估目录、`<MERGE>` 替换为主代理给出的合并命令后交给 subagent。

---

你负责为压缩质量评估构建标准答案。工作目录：`<DIR>`

## 输入

1. `rules.md`：评估规则与信息分类，含分段对应的 source.xml 行号，先读。
2. `source.xml`：压缩输入，须完整读完。个别行超过 2000 字符时阅读工具会截断，用 bash 命令查看全文。
3. `after.md`：区间之后的真实轨迹，用于判断信息后来是否被用到。

不读 `V*.xml`、`_blind_key.json`、`meta.json`。

## 任务

按分段建立清单。每读完一段就写出该段的分段文件，最后运行合并命令生成 `facts.json`。

- `facts`：约 20–35 条任务相关的原子事实，分类 A/B/C，重点挖掘 A 类。
  - 工具结果为空或仅为"成功"时，结合前序条目确定动作对象。压缩器容易在此张冠李戴。
  - 后续用到的信息优先，在 `evidence_after` 写明证据；无依据时省略该字段。
  - 分段内不写 id 与 position，由合并命令统一编号并按分段命名定位。
- `irrelevant`：约 10 条应省略或概括的 D 类信息，凭据标 `is_credential: true`。
- `source_indices` 为来源 index，`check_hint` 为判定保留的最低要点。

## 输出

分段写入 `parts/facts/`，没有内容的分段也要写空数组：

- `head.json`、`head-2.json`…：head 分段的事实，条数多时可拆多个文件按序号拼接。
- `mid.json`…、`tail.json`…：同理。
- `irrelevant.json`…：无关信息，字段 `fact` 与 `is_credential`。

```json
[{ "fact": "…", "category": "A", "source_indices": [0], "evidence_after": "…", "check_hint": "…" }]
```

全部写完后运行 `<MERGE>`。校验失败会列出全部问题且不写文件，按报错修正分段文件后重跑，直到成功。

最终回复各分段条数分布与最关键的几条 A 类事实。
