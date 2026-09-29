# Changelog

## Unreleased

- fix: 插件自产消息（`<history>` 替换检查点与压缩会话记录子会话消息）的 source 改用 producer-owned kind `plugin:dsh-plugin-om`（format v4 准入要求，与宿主 v3→v4 迁移对旧日志的产出一致），修复压缩后会话无法继续 AI 调用与导出的问题；新增宿主真实行准入与写编码的集成回归测试；src 全面清理 `as unknown as` 强转（消息经宿主 `createUserMessage` 构造、`MessageSourceMap` 声明插件自有 source、品牌 id 经宿主品牌构造函数标注）
