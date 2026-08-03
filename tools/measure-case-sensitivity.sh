#!/usr/bin/env bash
# ファイル名の大文字小文字の食い違いが、手元とサーバでどう変わるかを測る。
#
#   bash tools/measure-case-sensitivity.sh [multipass-vm-name]           # 003（CSS・既定）
#   bash tools/measure-case-sensitivity.sh --sample symptoms/001-case-sensitive-html \
#        --lower /guide.html --exact /Guide.html \
#        --out tools/results/001-case-sensitivity.json --vm verify-html-basics-001
#
# 測るもの: 実ファイル名が大文字を含むとき、
#   (a) 小文字パスを要求したときの HTTP ステータス
#   (b) 実ファイル名どおりのパスを要求したときの HTTP ステータス
# 手元（macOS の既定 = 大文字小文字を区別しない）と
# サーバ（Linux = 区別する）で同じ手順を実行する。
#
# 2026-07-29: 001（HTML 本体）でも測れるようパラメータ化した。
#             引数を省略すると 003（CSS）の既定値で動く（後方互換）。

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# --- 既定値は 003（CSS）---
SAMPLE_REL="symptoms/003-case-sensitive-css"
PATH_LOWER="/css/main-style.css"
PATH_EXACT="/css/Main-Style.css"
OUT_REL="tools/results/003-case-sensitivity.json"
VM="verify-html-basics-003"
ACTUAL_DIR="css"

POSITIONAL_VM=""
while [ $# -gt 0 ]; do
  case "$1" in
    --sample)     SAMPLE_REL="$2"; shift 2 ;;
    --lower)      PATH_LOWER="$2"; shift 2 ;;
    --exact)      PATH_EXACT="$2"; shift 2 ;;
    --out)        OUT_REL="$2"; shift 2 ;;
    --vm)         VM="$2"; shift 2 ;;
    --actual-dir) ACTUAL_DIR="$2"; shift 2 ;;   # 実ファイル名の一覧を取る相対ディレクトリ（"" ならサンプル直下）
    -*)           echo "unknown option: $1" >&2; exit 2 ;;
    *)            POSITIONAL_VM="$1"; shift ;;
  esac
done
[ -n "$POSITIONAL_VM" ] && VM="$POSITIONAL_VM"

SAMPLE="$ROOT/$SAMPLE_REL"
OUT="$ROOT/$OUT_REL"
BASENAME="$(basename "$SAMPLE_REL")"
PORT_LOCAL=8098
PORT_VM=8099

[ -d "$SAMPLE" ] || { echo "sample not found: $SAMPLE" >&2; exit 1; }
mkdir -p "$(dirname "$OUT")"

probe_local() {
  cd "$SAMPLE"
  python3 -m http.server "$PORT_LOCAL" >"/tmp/${BASENAME}-srv-local.log" 2>&1 &
  local pid=$!
  sleep 2
  local lower upper
  lower=$(curl -s -o /dev/null -w '%{http_code}:%{size_download}' "http://127.0.0.1:$PORT_LOCAL$PATH_LOWER")
  upper=$(curl -s -o /dev/null -w '%{http_code}:%{size_download}' "http://127.0.0.1:$PORT_LOCAL$PATH_EXACT")
  kill "$pid" 2>/dev/null || true
  echo "$lower $upper"
}

probe_vm() {
  multipass transfer -r "$SAMPLE" "$VM:/home/ubuntu/" >/dev/null
  # サーバはリダイレクトを閉じて起動する。開いたままだと exec が返らない
  multipass exec "$VM" -- bash -lc \
    "cd /home/ubuntu/$BASENAME && (setsid python3 -m http.server $PORT_VM </dev/null >/tmp/${BASENAME}-srv.log 2>&1 &) ; sleep 2"
  multipass exec "$VM" -- bash -lc \
    "curl -s -o /dev/null -w '%{http_code}:%{size_download} ' http://127.0.0.1:$PORT_VM$PATH_LOWER ;
     curl -s -o /dev/null -w '%{http_code}:%{size_download}' http://127.0.0.1:$PORT_VM$PATH_EXACT"
  multipass exec "$VM" -- bash -lc "pkill -f 'http.server $PORT_VM' || true" >/dev/null 2>&1 || true
}

read -r LOCAL_LOWER LOCAL_UPPER <<<"$(probe_local)"
read -r VM_LOWER VM_UPPER <<<"$(probe_vm)"

MAC_VER=$(sw_vers -productVersion)
VM_OS=$(multipass exec "$VM" -- bash -lc '. /etc/os-release; echo "$PRETTY_NAME"')
VM_KERNEL=$(multipass exec "$VM" -- uname -r)
VM_PY=$(multipass exec "$VM" -- python3 --version)
LOCAL_PY=$(python3 --version)
if [ -n "$ACTUAL_DIR" ]; then
  ACTUAL=$(ls -1 "$SAMPLE/$ACTUAL_DIR" | tr '\n' ' ')
else
  ACTUAL=$(ls -1 "$SAMPLE" | tr '\n' ' ')
fi
ACTUAL="${ACTUAL% }"

cat > "$OUT" <<JSON
{
  "scenario": "実ファイル名 $PATH_EXACT に対し、小文字パス $PATH_LOWER と実ファイル名どおりのパスを要求する",
  "sample": "$SAMPLE_REL",
  "actualFileName": "$ACTUAL",
  "requestedPaths": {
    "lower": "$PATH_LOWER",
    "exact": "$PATH_EXACT"
  },
  "environments": [
    {
      "where": "手元（macOS）",
      "os": "macOS $MAC_VER",
      "server": "$LOCAL_PY / http.server",
      "lower": "$LOCAL_LOWER",
      "exact": "$LOCAL_UPPER"
    },
    {
      "where": "サーバ（Linux）",
      "os": "$VM_OS",
      "kernel": "$VM_KERNEL",
      "server": "$VM_PY / http.server",
      "lower": "$VM_LOWER",
      "exact": "$VM_UPPER"
    }
  ],
  "format": "status:bytes",
  "measuredAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON

echo "wrote $OUT"
cat "$OUT"
