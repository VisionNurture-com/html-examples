#!/usr/bin/env bash
# measure-cross-os.sh — 検出件数とフックの挙動が OS をまたいで一致するかを測る
#
# 使い方（リポジトリのルートで実行する）:
#   bash tools/measure-cross-os.sh
#
# 2 つを測る。
#
#   ホスト側 … このシェルの node / git（WSL で実行すれば WSL の Ubuntu が対象）
#   windows  … WSL の interop 経由で Windows 側の node.exe / git.exe
#
# Windows 側を測るには次の 2 つが要る。満たさない場合はその旨を出力して飛ばす。
#   1. node.exe と git.exe が PATH から見えること（WSL の interop）
#   2. リポジトリが Windows から見える場所（/mnt/... 配下）にあること
#      Windows の実行ファイルに \\wsl.localhost 側のパスを渡す形は公式が推奨していないため測らない
#
# 出力: tools/results/010-cross-os-<darwin|linux|windows>.json（ホスト側は uname に追随する）
#
# 数値は「同じ題材で macOS と同じ件数が出るか」を見るためのもの。
# 実行時間は環境差が大きいため、比較の主眼は件数と終了コードに置く。
#
# Windows 側のフック測定は、フックの中の npx が Windows 側に解決されるかに依存する。
# 解決できなかった場合は終了コードとコミット数にその結果が出る。うまくいかなかったこと自体が
# OS 差の観測結果なので、失敗を隠さずそのまま JSON に残す。

set -uo pipefail

SAMPLE_BROKEN="symptoms/010-markup-errors/broken.html"
SAMPLE_FIXED="symptoms/010-markup-errors/fixed.html"
SAMPLE_PARSER="symptoms/010-parser-error/broken.html"
CONFIG="tools/.htmlvalidate.json"
HOOK="compare/010-validation-stages/githooks/pre-commit"
# 実体は .mjs。node で直接起動するのは、npx が Linux 側と Windows 側で別に解決されるため
# （Windows ネイティブを測るときに Linux の npx が混ざると、何を測ったのか言えなくなる）
CLI_JS="node_modules/html-validate/bin/html-validate.mjs"
RESULTS_DIR="tools/results"

if [ ! -f "$CONFIG" ]; then
  echo "リポジトリのルートで実行してください（$CONFIG が見つかりません）" >&2
  exit 1
fi

mkdir -p "$RESULTS_DIR"

# 指定した node で html-validate を動かし、error 行を数える。
count_errors() {
  local node_bin="$1" target="$2"
  "$node_bin" "$CLI_JS" --config "$CONFIG" --formatter text "$target" 2>/dev/null | grep -c 'error \[' || true
}

# 指定した node と git で、フックがコミットを止めるかを測る。
# 一時ディレクトリに履歴 1 つのリポジトリを作るので、作業リポジトリは汚さない。
measure_hook() {
  local git_bin="$1" workdir="$2"
  local created_broken created_bypass exit_broken exit_bypass

  mkdir -p "$workdir/tools" "$workdir/$(dirname "$HOOK")" "$workdir/$(dirname "$SAMPLE_BROKEN")"
  cp "$CONFIG" "$workdir/$CONFIG"
  cp "$HOOK" "$workdir/$HOOK"
  cp "$SAMPLE_BROKEN" "$workdir/$SAMPLE_BROKEN"
  cp "$SAMPLE_FIXED" "$workdir/$(dirname "$SAMPLE_BROKEN")/"
  chmod +x "$workdir/$HOOK"
  # Windows から見える場所（/mnt/...）では symlink を Windows 側のツールが辿れないことがあるため複製する。
  # Linux だけで測るときは symlink で足りる（node_modules は 30 MB 台）。
  if [[ "$workdir" == /mnt/* ]]; then
    cp -R node_modules "$workdir/node_modules"
  else
    ln -s "$PWD/node_modules" "$workdir/node_modules" 2>/dev/null || cp -R node_modules "$workdir/node_modules"
  fi

  # node_modules を git add すると数千ファイルを扱うことになり、環境によってコミットが失敗する。
  # 検証対象は HTML なので、追跡対象から外す。
  printf 'node_modules/\n' > "$workdir/.gitignore"

  (
    cd "$workdir" || exit 1
    "$git_bin" init --quiet -b main >/dev/null 2>&1
    "$git_bin" add . >/dev/null 2>&1
    "$git_bin" -c user.name=test -c user.email=test@example.com commit --no-verify --quiet -m baseline >/dev/null 2>&1
    "$git_bin" config core.hooksPath "$(dirname "$HOOK")"

    echo '<!-- 測定のための追記 -->' >> "$SAMPLE_BROKEN"
    "$git_bin" add "$SAMPLE_BROKEN" >/dev/null 2>&1
    "$git_bin" -c user.name=test -c user.email=test@example.com commit -m broken >/dev/null 2>&1
    echo "exit_broken=$?"
    echo "count_after_broken=$("$git_bin" rev-list --count HEAD)"

    "$git_bin" -c user.name=test -c user.email=test@example.com commit --no-verify -m bypass >/dev/null 2>&1
    echo "exit_bypass=$?"
    echo "count_after_bypass=$("$git_bin" rev-list --count HEAD)"
  )
}

emit_json() {
  # 変数を JSON へ落とす。ここで node を使うのは、引用の取り違えを避けるため。
  local out="$1" platform="$2" node_bin="$3" git_bin="$4"
  local broken="$5" fixed="$6" parser="$7" hook_log="$8"
  "$NODE_FOR_JSON" -e '
    const [out, platform, nodeBin, gitBin, broken, fixed, parser, hookLog] = process.argv.slice(1);
    const parse = (log, key) => { const m = new RegExp(key + "=(-?\\d+)").exec(log); return m ? Number(m[1]) : null; };
    const result = {
      measuredAt: new Date().toISOString(),
      platform,
      binaries: { node: nodeBin, git: gitBin },
      versions: {},
      counts: { broken: Number(broken), fixed: Number(fixed), parserError: Number(parser) },
      hook: {
        exitWithBrokenHtml: parse(hookLog, "exit_broken"),
        commitsAfterBrokenAttempt: parse(hookLog, "count_after_broken"),
        exitWithNoVerify: parse(hookLog, "exit_bypass"),
        commitsAfterNoVerify: parse(hookLog, "count_after_bypass"),
      },
      raw: { hookLog },
    };
    require("node:fs").writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
    console.log(`written: ${out}`);
  ' "$out" "$platform" "$node_bin" "$git_bin" "$broken" "$fixed" "$parser" "$hook_log"
}

NODE_FOR_JSON="node"

# 出力名は実際に測ったプラットフォームに合わせる。
# 固定で -linux.json に書くと、macOS で試したときに Linux の測定値を上書きしてしまう（実際に一度壊した）。
HOST_TAG=$(uname -s | tr '[:upper:]' '[:lower:]')

# 波括弧で囲むのは、直後の全角括弧が変数名の一部として解釈されるのを避けるため。
echo "=== ${HOST_TAG}（このシェルの node / git）==="
if command -v node >/dev/null 2>&1 && command -v git >/dev/null 2>&1; then
  L_BROKEN=$(count_errors node "$SAMPLE_BROKEN")
  L_FIXED=$(count_errors node "$SAMPLE_FIXED")
  L_PARSER=$(count_errors node "$SAMPLE_PARSER")
  L_TMP=$(mktemp -d)
  L_HOOK_LOG=$(measure_hook git "$L_TMP/repo")
  rm -rf "$L_TMP"
  echo "broken=$L_BROKEN fixed=$L_FIXED parser=$L_PARSER"
  echo "$L_HOOK_LOG"
  emit_json "$RESULTS_DIR/010-cross-os-$HOST_TAG.json" "$(uname -s)-$(uname -m)" "$(command -v node)" "$(command -v git)" \
    "$L_BROKEN" "$L_FIXED" "$L_PARSER" "$L_HOOK_LOG"
else
  echo "skip: node または git が見つかりません" >&2
fi

echo
echo "=== windows（WSL interop 経由の node.exe / git.exe）==="
if ! command -v node.exe >/dev/null 2>&1 || ! command -v git.exe >/dev/null 2>&1; then
  echo "skip: node.exe / git.exe が PATH から見えません（WSL 以外で実行している、または Windows 側に未導入）"
elif [[ "$PWD" != /mnt/* ]]; then
  echo "skip: リポジトリが Windows から見える場所（/mnt/...）にありません。現在地: $PWD"
  echo "      Windows ネイティブとして測るには C: 配下へ clone してから実行してください。"
else
  W_BROKEN=$(count_errors node.exe "$SAMPLE_BROKEN")
  W_FIXED=$(count_errors node.exe "$SAMPLE_FIXED")
  W_PARSER=$(count_errors node.exe "$SAMPLE_PARSER")
  # フックの中の npx は Windows 側の PATH で解決される。sshd 経由の WSL セッションや
  # Node 導入直後のセッションでは PATH が古いままで解決できない。測る前に確かめる。
  NODE_EXE_DIR=$(dirname "$(command -v node.exe)")
  W_NPX=$(cmd.exe /C "where npx" 2>/dev/null | tr -d "\r" | head -1)
  GIT_RUNNER="git.exe"
  if [ -z "$W_NPX" ]; then
    # Windows 側の PATH に nodejs が無い（Node 導入直後や sshd 経由のセッションで起きる）。
    # git.exe を素で呼ぶとフックの中の npx が解決できないため、PATH を足す .cmd を経由させる。
    echo "note: Windows の PATH から npx が解決できないため、PATH を補う経路で測ります（node.exe: ${NODE_EXE_DIR}）"
    WIN_NODE_DIR=$(wslpath -w "$NODE_EXE_DIR")
    CMD_EXE=$(command -v cmd.exe 2>/dev/null || echo /mnt/c/Windows/System32/cmd.exe)
    WRAPPER_DIR="$PWD/.win-runner"
    mkdir -p "$WRAPPER_DIR"
    # .cmd 側は CRLF で書く。cd 先は WSLENV 経由で受け取る（PATH 自体は Windows 側の値が使われる）。
    {
      printf '@echo off\r\n'
      printf 'set "PATH=%s;%%PATH%%"\r\n' "$WIN_NODE_DIR"
      printf 'cd /d %%GITWIN_CWD%%\r\n'
      printf 'git %%*\r\n'
    } > "$WRAPPER_DIR/gitwin.cmd"
    WIN_WRAPPER=$(wslpath -w "$WRAPPER_DIR/gitwin.cmd")
    {
      printf '#!/bin/sh\n'
      printf '# cmd.exe 経由で Windows の git を呼ぶ。cwd は WSLENV で Windows 側へ渡す。\n'
      printf 'GITWIN_CWD=$(wslpath -w "$PWD"); export GITWIN_CWD\n'
      printf 'export WSLENV="${WSLENV:+$WSLENV:}GITWIN_CWD"\n'
      printf 'exec "%s" /C "%s" "$@"\n' "$CMD_EXE" "$WIN_WRAPPER"
    } > "$WRAPPER_DIR/gitwin.sh"
    chmod +x "$WRAPPER_DIR/gitwin.sh"
    GIT_RUNNER="$WRAPPER_DIR/gitwin.sh"
  fi
  W_TMP=$(mktemp -d -p "$(dirname "$PWD")")
  W_HOOK_LOG=$(measure_hook "$GIT_RUNNER" "$W_TMP/repo")
  rm -rf "$W_TMP" "$PWD/.win-runner"
  echo "broken=$W_BROKEN fixed=$W_FIXED parser=$W_PARSER"
  echo "$W_HOOK_LOG"
  emit_json "$RESULTS_DIR/010-cross-os-windows.json" "windows-via-wsl-interop" "$(command -v node.exe)" "${GIT_RUNNER}" \
    "$W_BROKEN" "$W_FIXED" "$W_PARSER" "$W_HOOK_LOG"
fi

echo
echo "macOS の実測値（比較の基準）: broken=11 fixed=0 parser=1 / フックは exit=1 でコミットなし・--no-verify は exit=0 でコミットあり"
