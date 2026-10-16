# 事实清单提示词

将 `<DIR>` 替换为评估目录后交给 subagent。

---

你负责为压缩质量评估构建标准答案。工作目录：`<DIR>`

## 输入

1. `rules.md`：评估规则与信息分类，先读。
2. `source.xml`：压缩输入，须完整读完。
3. `after.md`：区间之后的真实轨迹，用于判断信息后来是否被用到。

不读 `V*.xml`、`_blind_key.json`、`meta.json`。

## 任务

为该区间建立清单，写入 `facts.json`。

- `facts`：约 20–35 条任务相关的原子事实，分类 A/B/C，重点挖掘 A 类。
  - 工具结果为空或仅为"成功"时，结合前序条目确定动作对象。压缩器容易在此张冠李戴。
  - 后续用到的信息优先，在 `evidence_after` 写明证据。
  - `position` 标 head/mid/tail，按信息实际分布覆盖三段。
- `irrelevant`：约 10 条应省略或概括的 D 类信息，凭据标 `is_credential: true`。
- `source_indices` 为来源 index，`check_hint` 为判定保留的最低要点。

## 输出

```json
{
  "facts": [{ "id": "F01", "fact": "…", "category": "A", "source_indices": [0], "position": "head", "evidence_after": "…", "check_hint": "…" }],
  "irrelevant": [{ "id": "D01", "content": "…", "source_indices": [0], "position": "head", "reason": "…", "is_credential": false }]
}
```

最终回复条数分布与最关键的几条 A 类事实。
