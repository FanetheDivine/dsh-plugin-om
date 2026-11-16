# 已知风险

## 归档与 skill 注入

- 注入的 skill 与用户手动引用 skill 无法区分，主模型可能把它当成新指令重新执行 skill 流程。
- 压缩会话把 skill 当普通内容处理，观察阶段可能已把 skill 压成摘要，归档时提取不到，原文只能用 recall 找回。
- 归档运行期间若 history 块变化，提交前校验失败，本次结果丢弃，下次检测重新归档。
- 归档结果只存内存，进程重启后重新检测。

## 写入 plugin record

观察待定标记、预压缩结果和降级警告经宿主 `appendPluginRecord` 写入会话日志，类型为 `plugin:dsh-plugin-om/*` 的 ignorable 记录。

- 该 API 属宿主实验性接口，格式迁移时记录只尽力保留。丢失后预压缩结果重新压缩，待定标记重新触发。
- 要求 DSH 0.2.1-rc.2 或更高版本，更低版本没有 `appendPluginRecord`。
- 不识别写入 `feedback/record` 的 `om:1:` 信封，这类会话里未完成的观察待定、预压缩结果和降级警告行失效。

## 改写 Claude 请求

Claude 的 thinking 签名绑定其前全部内容，宿主也未开放 `drop_block`。因此插件在 `llm/stream` 中改写请求，剥离压缩前生成的签名。

- 改写后的请求仍由会话日志确定，但宿主请求查看显示的是改写前的内容。
- 插件与宿主加载的 `dsh-llm` 不是同一份时，改写后的请求会丢失 agent loop 标记，这次请求不触发会话标题生成。
- 未强制校验签名的账号同样会剥离，压缩后尾部的 reasoning 不再发给 Claude。
