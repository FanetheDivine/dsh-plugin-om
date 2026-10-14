# Changelog

## Changes

- AGENTS.md 规范新增与用户交互时优先调用 `ask_user_question` 的要求。
- 压缩卡片的操作按钮移至展开体下方，样式对齐宿主 Inspect 胶囊按钮。
- 压缩卡片的「查看」更名为「诊断日志」，跳转诊断子会话；「轨迹」按钮因无法定位具体条目暂以 display:none 隐藏。
- 压缩摘要不在加载窗口内时，卡片仍可展开并使用操作按钮。
- 压缩成功时 completeCompression 的结果由「压缩完成」改为最终 `<history>` 块，与压缩日志一致，会话记录中可直接查看压缩产物。
