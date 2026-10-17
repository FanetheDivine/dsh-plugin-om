# Changelog

## Unreleased

## Changes

- real-device-test skill 按 DSH 0.2.1 实测更新：全局 dsh 与依赖版本一致用全局，不一致由 `setup-env.sh` 本地安装到 `~/.dsh-local/dsh-<版本>` 并输出 `PATH` 与 `OM_DSH_PKG`，不改全局；`gui-up.sh` 等 token 秒数可配，进程退出即失败。配置表单入口改为插件管理器「查看」进详情页、组件行「配置」打开表单；`diag` 按 `data-om-compaction-inspect` 点「诊断日志」并断言切到诊断子会话；`connect` 用路径形式 `/json/close/<id>` 关旧 tab，修复 tab 积压导致的 CDP 卡死；`openCard` 排除恢复路由下的子会话。pitfalls 新增宿主插件导出形态、服务因 `static inject` 缺依赖静默挂起、卡片文案以 locales 为准、本地宿主解析等条目。
