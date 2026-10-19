# Changelog

## Unreleased

## Changes

- fix: 反思提交后 Claude thinking 签名过期判定失效导致请求 400。签名剥离的分界原取表层最后一条 OM 消息，反思的 `<archived-history>` 块追加在日志尾部但表层位于保留的旧 `<history>` 块之前，分界被旧块抢占后过期判定为空、签名不剥离。分界改取 seq 最大的 OM 消息（最新替换检查点）。
- 压缩会话首条消息注入区间条目的标题行去掉「（等同 getHistory 全区间返回）」括注，只保留「区间当前条目：」。
