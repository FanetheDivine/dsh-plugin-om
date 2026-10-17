#!/bin/bash
# 后台启动 profile GUI 并提取访问 token（每次启动 token 轮转）。
# 用法：bash gui-up.sh <profile名> [端口]；输出三行 export，可 eval 进当前 shell。
# env：OM_GUI_PORT（默认 3210）、OM_GUI_WAIT（等 token 秒数，默认 90）。
# 坑：端口残留进程会 EADDRINUSE 并连锁「required plugins did not activate」，先杀再起。
set -u
PROFILE=${1:?用法: bash gui-up.sh <profile名> [端口]}
PORT=${2:-${OM_GUI_PORT:-3210}}
PDIR=${DSH_HOME:-$HOME/.dsh}/profiles/$PROFILE
cd "$PDIR" || exit 1
PID=$(netstat -ano | grep ":$PORT " | grep LISTENING | awk '{print $5}' | head -1)
[ -n "$PID" ] && taskkill //F //PID "$PID" >/dev/null 2>&1
rm -f gui-run.log
nohup dsh --profile "$PROFILE" --no-open --port $PORT > gui-run.log 2>&1 &
GUI_PID=$!
# 冷启动可能超过 30s，等待秒数由 OM_GUI_WAIT 覆盖；进程退出即失败
for i in $(seq 1 ${OM_GUI_WAIT:-90}); do
  grep -q "token=" gui-run.log 2>/dev/null && break
  kill -0 "$GUI_PID" 2>/dev/null || break
  sleep 1
done
TOKEN=$(grep -o "token=[A-Za-z0-9_-]*" gui-run.log | head -1 | cut -d= -f2)
if [ -z "$TOKEN" ]; then echo "GUI 启动失败，查看 $PDIR/gui-run.log" >&2; exit 1; fi
echo "export OM_GUI_PORT=$PORT"
echo "export OM_GUI_TOKEN=$TOKEN"
echo "export OM_GUI_URL='http://127.0.0.1:$PORT/?token=$TOKEN'"
