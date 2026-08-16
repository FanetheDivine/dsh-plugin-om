# Changelog

- 优化skill
- feat: 压缩时机支持 turn 中间触发——`computeCompressRange` 去掉 turn/end 封顶，pre-step 时日志 call-result 完备即可压缩当前 turn 消息；区间终点回退到 tool-call/result 配对平衡点（不切段）
- feat: 摘要改直连 `ctx.llm.stream()`（不再 fork 子会话），新增环境变量 `DSH_OM_SUMMARY_MODE` 双模式：`prefix`（缺省）复用主会话 `requestHeader()` 的 system/tools 与完整派生历史 + 末尾指令 user 消息（充分利用 provider 前缀缓存）；`system` 模式指令作为 system、被压缩消息与参考尾部作为 user 输入；usage 从流式 usage chunk 提取归入主会话
- feat: `tailMessageCount` 语义改为「不压缩的消息」（尾部保留、不参与替换），同时作为摘要模型的参考尾部（摘要须准确反映最近上下文进度/下一步）
- docs: 同步 README（工作原理 / 配置项与环境变量 / 调用链文件地图）与 CHANGELOG
