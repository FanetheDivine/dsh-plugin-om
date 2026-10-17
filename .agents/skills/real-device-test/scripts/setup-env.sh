#!/bin/bash
# 一键搭建 OM 实机测试环境：dsh 版本对齐 → 建 profile → 安装 dist 插件 → 写隔离配置 → 复制驱动脚本 → 注册工作区。
# 用法：bash setup-env.sh <插件仓库绝对路径> [profile名]（默认 om-test-<日期>）
# 前置：仓库已 pnpm i && pnpm check（需要 dist/index.mjs）。
# 产物：profile 目录内 cordis.patch.yml / mock-provider.mjs / run-om-test.mjs / run-om-cold.mjs / cdp-ui.mjs / test-sessions / test-storage。
set -euo pipefail
REPO_IN=${1:?用法: bash setup-env.sh <插件仓库绝对路径> [profile名]}
PROFILE=${2:-om-test-$(date +%Y%m%d)}
REPO=$(cygpath -m "$REPO_IN")          # Windows 风格（D:/...），供 node/dsh 使用
REPO_U=$(cygpath -u "$REPO_IN")        # MSYS 风格（/d/...），供 bash 使用
DSH_ROOT=${DSH_HOME:-$HOME/.dsh}
PDIR_U="$DSH_ROOT/profiles/$PROFILE"
PDIR=$(cygpath -m "$PDIR_U")
SCRIPTS_DIR=$(cd "$(dirname "$0")" && pwd)

echo "== 1/6 dsh 版本对齐"
WANT=$(node -e "process.stdout.write(require(process.argv[1]).devDependencies['@deepseek-ai/dsh-llm']??'')" "$REPO/package.json")
[ -n "$WANT" ] || { echo "无法从 $REPO/package.json 读出 @deepseek-ai/dsh-llm 版本"; exit 1; }
HAVE=$(dsh --version 2>/dev/null || echo "")
if [ "$HAVE" != "$WANT" ]; then
  echo "dsh 当前 ${HAVE:-未安装}，插件要求 $WANT，安装 @deepseek-ai/dsh@$WANT ..."
  npm i -g "@deepseek-ai/dsh@$WANT"
  HAVE=$(dsh --version)
  [ "$HAVE" = "$WANT" ] || { echo "安装后仍不一致（$HAVE != $WANT）"; exit 1; }
fi
echo "dsh $HAVE 与插件要求一致"

echo "== 2/6 检查 dist 产物"
[ -f "$REPO_U/dist/index.mjs" ] || { echo "缺 $REPO/dist/index.mjs，先在仓库跑 pnpm check"; exit 1; }

echo "== 3/6 创建 profile"
if [ -d "$PDIR_U" ]; then
  echo "profile $PROFILE 已存在，复用"
else
  dsh --profile "$PROFILE" --from-default-profile web --dump-config
fi

echo "== 4/6 安装插件（pnpm pack + dsh plugin add）"
# tgz 必须留在 profile 目录内：package.json 的 file: 依赖指向它，删除会导致重跑安装失败
TGZ=$(cd "$REPO_U" && pnpm pack --pack-destination "$PDIR_U" | tail -1)
TGZ_M=$(cygpath -m "$TGZ" 2>/dev/null || echo "$TGZ")
dsh plugin --profile "$PROFILE" add "$TGZ_M"

echo "== 5/6 写隔离配置 + 复制驱动脚本"
# --dump-config 生成的 patch 是非空空壳（注释 + []），须按内容判断是否已配置过
if grep -q "om-test-mock" "$PDIR_U/cordis.patch.yml" 2>/dev/null; then
  echo "cordis.patch.yml 已含测试配置，保留不覆盖"
else
  cat > "$PDIR_U/cordis.patch.yml" <<EOF
# OM 实机测试隔离配置：无真实模型，mock provider 由文件尾部 insert 加载。
- id: dsh-plugin-om
  config:
    omEnabled: true
    observeThresholdTokens: 1000000
    reflectThresholdTokens: 1000000
    tailMessageCount: 0
    rateLimitWaitMs: 0
    semanticRecallEnabled: false
    recallEnabled: true
    debug: true
- id: agent-default-model
  config:
    provider: mock
    model: claude-mock
    reasoningEffort: low
- id: llm-deepseek
  disabled: true
- id: llm-deepseek-account
  disabled: true
- id: llm-pi-ai
  disabled: true
- id: session-title-llm
  disabled: true
- id: session-persistence-jsonl
  config:
    root: $PDIR/test-sessions
    compression: none
- id: storage-json
  config:
    root: $PDIR/test-storage
- insert:
    - id: om-test-mock
      name: $PDIR/mock-provider.mjs
- id: ui-settings-general
  name: "@deepseek-ai/dsh-client-ui-settings-general"
  config:
    welcomeNoticeVersion: 2026-09-28.1
EOF
fi
mkdir -p "$PDIR_U/test-sessions" "$PDIR_U/test-storage" "$PDIR_U/shots"
cp "$SCRIPTS_DIR/mock-provider.mjs" "$SCRIPTS_DIR/run-om-test.mjs" "$SCRIPTS_DIR/run-om-cold.mjs" "$SCRIPTS_DIR/cdp-ui.mjs" "$PDIR_U/"

echo "== 6/6 注册测试工作区"
node "$SCRIPTS_DIR/register-workspace.mjs" "$PDIR_U" "$REPO"

cat <<EOF

环境就绪。后续步骤（env 覆盖脚本默认值）：
  export OM_PROFILE=$PROFILE OM_PROFILE_DIR=$PDIR OM_REPO=$REPO
  cd $PDIR_U
  OM_REPO=\$OM_REPO node run-om-test.mjs        # warm 电池
  node run-om-cold.mjs                          # cold 电池（依赖 warm 的 omtest-cold）
  bash $SCRIPTS_DIR/chrome-up.sh                # 专用 Chrome（CDP 9334）
  eval \$(bash $SCRIPTS_DIR/gui-up.sh $PROFILE) # GUI + token
  node cdp-ui.mjs <step>                        # 浏览器用例（step 见脚本内分派表）
EOF
