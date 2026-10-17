#!/bin/bash
# 启动专用 Chrome 实例（普通模式 + CDP），供 cdp-ui.mjs 连接。
# 用法：bash chrome-up.sh [端口] [userDataDir]
# 坑：headless 模式在本环境导航挂起，用普通模式；CDP 全超时视为假死，重跑本脚本换新实例。
set -u
PORT=${1:-${OM_CDP_PORT:-9334}}
UDD=${2:-D:/tmp/om-chrome-$PORT}
CHROME=${OM_CHROME:-"/c/Program Files/Google/Chrome/Application/chrome.exe"}
NAME=$(basename "$UDD")
# 杀掉同 userDataDir 的残留实例（按命令行匹配，避免误杀日常 Chrome）
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { \$_.CommandLine -like '*$NAME*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }" >/dev/null 2>&1
sleep 2
nohup "$CHROME" --remote-debugging-port=$PORT --user-data-dir="$UDD" --no-first-run --no-default-browser-check about:blank > "$UDD.log" 2>&1 &
for i in $(seq 1 20); do curl -s --max-time 2 http://127.0.0.1:$PORT/json/version >/dev/null 2>&1 && break; sleep 1; done
curl -s --max-time 3 http://127.0.0.1:$PORT/json/version | head -c 60; echo
