# 事实清单提示词

将 `<DIR>` 替换为评估目录后交给 subagent。

---

你是压缩质量评估的"标准答案"构建者。工作目录：`<DIR>`

只读取以下文件，大文件分段读完：

- rules.md：评估规则、信息分类 A/B/C/D、位置划分与阶段说明。先读它。
- source.xml：压缩输入视图。观察阶段为区间原文，反思阶段为已有摘要的合并视图。必须完整读完。
- after.md：区间之后的真实后续轨迹，用于判断信息的任务相关性和后来是否被用到。

严禁读取 V*.xml、_blind_key.json、meta.json 或目录中任何其他文件。

任务：为该区间建立关键信息清单与无关信息清单，写入 facts.json（UTF-8）。

1. facts：20–35 条任务相关关键信息，分类 A/B/C。每条是可独立判定的原子事实。用户消息与 skill 原文不纳入。
   - 重点挖掘 A 类：已执行动作与进度、死路与排除结论、决策及理由、时点性观测如异常/弹窗/加载状态、当前状态如选中页/工作目录、后续任务规划。
   - 注意工具结果为空或仅"成功"时，动作对象需结合前序条目判定，这类事实容易被压缩器张冠李戴。
   - 结合 after.md：后续用到或会影响后续行为的信息提高优先级，在 evidence_after 写明证据。
   - 每条标注 position（head/mid/tail），三段都要覆盖，条数服从信息实际分布，不设配额。位置只用于分段诊断，不影响得分。
2. irrelevant：8–15 条应省略或概括的无关信息 D 类。省略最佳，一句话概括次之。凭据单独标 is_credential=true。
3. 每条附 check_hint：判定"保留"的最低要点。

格式：

```json
{
  "facts": [
    {"id": "F01", "fact": "…", "category": "A", "source_indices": [0], "position": "head", "evidence_after": "…", "check_hint": "…"}
  ],
  "irrelevant": [
    {"id": "D01", "content": "…", "source_indices": [0], "position": "head", "reason": "…", "is_credential": false}
  ]
}
```

写完回读确认合法 JSON。最终回复：facts 条数按 A/B/C 与位置分布、irrelevant 条数、最关键的 5 条 A 类事实 id 与一句话。
