# 事实清单提示词

将 `<DIR>` 替换为评估目录后交给 subagent。

---

你负责为压缩质量评估构建标准答案。工作目录：`<DIR>`

## 输入

只读以下文件，大文件分段读完：

1. `rules.md`：评估规则、信息分类 A/B/C/D、位置与阶段说明。先读。
2. `source.xml`：压缩输入视图。观察阶段为区间原文，反思阶段为已有摘要的合并视图。必须完整读完。
3. `after.md`：区间之后的真实轨迹，用于判断信息是否任务相关、后来是否被用到。

禁止读取 `V*.xml`、`_blind_key.json`、`meta.json` 及目录中其他文件。

## 任务

为该区间建立关键信息清单与无关信息清单，写入 `facts.json`，UTF-8 编码。

### facts

- 20–35 条任务相关信息，分类 A/B/C。每条是可独立判定的原子事实。
- 不纳入用户消息与 skill 原文。
- 重点挖掘 A 类：
  - 已执行动作与进度
  - 死路与排除结论
  - 决策及理由
  - 时点性观测，如异常、弹窗、加载状态
  - 当前状态，如选中页、工作目录
  - 后续任务规划
- 工具结果为空或仅为"成功"时，结合前序条目确定动作对象。压缩器容易在此张冠李戴。
- 后续用到或影响后续行为的信息优先，在 `evidence_after` 写明证据。
- `position` 标 head/mid/tail。三段都要覆盖，条数按信息实际分布，不设配额。

### irrelevant

- 8–15 条应省略或概括的 D 类无关信息。
- 凭据标 `is_credential: true`。

### 公共字段

- `source_indices`：来源 index。
- `check_hint`：判定"保留"的最低要点。

## 输出

```json
{
  "facts": [{ "id": "F01", "fact": "…", "category": "A", "source_indices": [0], "position": "head", "evidence_after": "…", "check_hint": "…" }],
  "irrelevant": [{ "id": "D01", "content": "…", "source_indices": [0], "position": "head", "reason": "…", "is_credential": false }]
}
```

- 写完回读，确认是合法 JSON。
- 最终回复：
  - facts 按 A/B/C 与位置的条数分布
  - irrelevant 条数
  - 最关键的 5 条 A 类事实 id，各附一句话
