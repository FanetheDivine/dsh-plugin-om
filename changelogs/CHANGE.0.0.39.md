# Changelog

## [0.0.39] - 2026-09-18

## Unreleased

### Changed

- 适配 dsh 0.1.5-rc.2：压缩替换的 surfaceOp 载荷改用 `startSeq`/`endSeq` 字段，压缩会话记录的 assistant/message 载荷携带 `stream` 字段
- 依赖的 @deepseek-ai/dsh-* 全套升级到 0.1.5-rc.2，适配版本为 dsh 0.1.5-rc.2 及以上
