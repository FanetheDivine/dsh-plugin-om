# Changelog

- feat: 模型下载开始/结束 console 日志（运行时 console + 插件日志双通道）；下载失败时错误消息建议设置 `HF_ENDPOINT=https://hf-mirror.com` 走镜像
- feat: 默认模型目录改为 `$DSH_HOME/plugin-data/dsh-plugin-om/models/<模型id>`（跨插件版本共享；随包小文件缺失时从插件包复制补齐，onnx 按需下载到共享目录；`download:model` CLI 目标同步）
- docs: README 同步模型下载日志与跨版本共享模型目录说明
