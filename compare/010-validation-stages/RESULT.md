# 010: 検証をどこに置くか（エディタ / pre-commit / CI）の実測比較

- 作成日: 2026-07-26
- 対象: 3 段階の配置。**エディタのみ** / **+ pre-commit** / **+ CI**
- 設定: [`.htmlvalidate.json`](.htmlvalidate.json)（`html-validate:recommended` のみ）
- サンプル: [`../../symptoms/010-markup-errors/`](../../symptoms/010-markup-errors/) / [`../../symptoms/010-embedded-errors/`](../../symptoms/010-embedded-errors/) / [`../../symptoms/010-parser-error/`](../../symptoms/010-parser-error/)

## 3 段階の定義（何を測るか）

| 段階 | 検査の契機 | 検査の範囲 | 本リポジトリでの再現方法 |
|---|---|---|---|
| 1. エディタのみ | 入力中（保存不要） | **開いたファイルだけ** | 1 ファイルを CLI に通す |
| 2. + pre-commit | `git commit` 実行時 | コミット対象の変更ファイル | [`githooks/pre-commit`](githooks/pre-commit) が `git diff --cached` の一覧を渡す |
| 3. + CI | push / pull request | **全ファイル** | [`../../.github/workflows/html-validate.yml`](../../.github/workflows/html-validate.yml) |

## 実測値

macOS（2026-07-26・5 回の中央値）:

| 指標 | 1. エディタのみ | 2. + pre-commit | 3. + CI | 取得方法 |
|---|---:|---:|---:|---|
| 検査したファイル数 | 1 | 2 | **14** | `node tools/measure-validate-stages.mjs` |
| 検出件数 | 11 | 11 | **15** | 同上 |
| 実行時間・CLI 起動込み | 411.1 ms | 412.1 ms | **486.1 ms** | 同上 |
| 実行時間・検証のみ（API） | 6.2 ms | 7.0 ms | **37.5 ms** | 同上 |

**読み取り**: 検査するファイルが 1 本から 14 本へ増えても、CLI 全体では 75 ms しか伸びません。同じ範囲の差で検証そのものは 6.2 ms → 37.5 ms（6 倍）になっています。つまり**待ち時間の大半は html-validate の起動コスト**であり、置き場所を変えたときに効くのはファイル数よりも「1 回あたり起動するか」です。

Linux（Ubuntu 26.04 arm64・Node 24.18.0・同条件）:

| 指標 | 1. エディタのみ | 2. + pre-commit | 3. + CI |
|---|---:|---:|---:|
| 検出件数 | 11 | 11 | 15 |
| 実行時間・CLI 起動込み | 236.2 ms | 242.7 ms | 323.8 ms |
| 実行時間・検証のみ（API） | 4.6 ms | 7.6 ms | 38.6 ms |

**検出件数は OS をまたいで一致**します。実行時間は環境差が出るため（この Linux は仮想マシン・arm64）、比較の主眼は件数に置きます。

> 数値は `tools/results/010-validate-stages.json`（macOS）と `010-validate-stages-linux.json`（Linux）を正本とします。手打ちの観測値は書きません（数値の出所は生ログに限る）。

## フックはコミットを止めるか（`010-hook.json` / `010-hook-linux.json`）

| 操作 | 終了コード | コミットが作られたか | macOS | Linux |
|---|:--:|:--:|:--:|:--:|
| 壊れた HTML を stage して `git commit` | **1** | **作られない** | ✅ | ✅ |
| 同じ状態で `git commit --no-verify` | 0 | **作られる** | ✅ | ✅ |
| 妥当な HTML だけで `git commit` | 0 | 作られる | ✅ | ✅ |

`--no-verify` で通ってしまう以上、**フックは関門ではなく安全網**です。関門は CI 側に置きます。

## 解析の打ち切り（`010-parser-error.json` / `010-parser-error-linux.json`）

| 題材 | 検出件数 | ルール |
|---|:--:|---|
| `symptoms/010-parser-error/broken.html`（打ち間違いの断片あり） | **1** | `parser-error` のみ |
| 同じファイルからその 1 行だけを取り除いたもの | **9** | `close-order` / `no-implicit-close` / `wcag/h30` / `wcag/h37` |

タグとして読めない断片が 1 つ入ると、**その後ろの誤りは報告されません**（macOS / Linux で同じ結果）。件数が減ったときに「直った」と読むと逆方向へ進みます。

## ブラウザでは表示できるのか（`010-render.json`）

chromium 151.0.7922.34 / firefox 153.0 / webkit 26.5 の 3 エンジンで、`broken.html` と `fixed.html` を開いて比べました。

| 観測 | broken | fixed |
|---|---|---|
| 見出しが読めるか | 読める（領域あり） | 読める |
| 段落の数 | 2 | 2 |
| `#lead` に一致する要素数 | **2**（id が重複していても両方 DOM に残る） | 1 |
| 閉じていない `a` の描画 | **幅 0 で描画されない**（リンク文字がないため） | 通常のリンクとして描画 |

3 エンジンで結果は同じでした。**仕様上 11 件の誤りを含むページが、見た目には問題なく表示されます**。画像ファイルは同梱していないため、どちらのファイルでも読み込みエラーが 1 件出ます（マークアップ起因ではありません）。

## 導入形態の差（`010-extension-modes.json`）

拡張機能 `html-validate.vscode-html-validate` 2.15.5 の言語サーバーを `--stdio` で直接起動し、`publishDiagnostics` を数えました（VS Code の GUI は使いません）。

| モード | `node_modules/html-validate` | 検出件数 | ルール名 | 位置 |
|---|:--:|:--:|:--:|:--:|
| プロジェクトローカル導入 | あり | 11 | 一致 | 一致 |
| 同梱版 | なし | 11 | 一致 | 一致 |

**この題材では差が出ませんでした**。公式が挙げている差は「同梱版は純粋な `.html` のみ対応（Vue や Markdown は不可）」で、`.html` 単体の検証なら結果が変わらないという実測と整合します。

あわせて、**拡張機能の 11 件が CLI の 11 件と `ルール@行:列` まで一致**することを機械照合で確認しました。

```
doctype-style@1:1 no-implicit-close@2:2 no-implicit-close@7:4 no-implicit-close@10:6
no-dup-id@11:12 element-permitted-content@14:8 wcag/h37@18:6 close-order@20:6
wcag/h30@20:6 close-order@21:4 close-order@22:2
```

### VS Code 側の実測（macOS・2026-07-26 取得済み）

| 題材 | html-validate CLI | VS Code 組み込みのみ | VS Code + 拡張機能 |
|---|:--:|:--:|:--:|
| `symptoms/010-markup-errors/broken.html` | **11** | **0** | **11** |
| `symptoms/010-embedded-errors/broken.html` | **1**（`doctype-style` のみ） | **5** | **6** |

組み込みと拡張機能は領域が重ならず、`6 = 5 + 1` は行単位で確認済みです。測定の詳細と証跡（画面撮影）は記事側セッションの `verify/vscode-probe/` にあります。

## 設定ファイルとコマンド

素の Git フックを使う場合（本記事の主軸）:

```bash
git config core.hooksPath compare/010-validation-stages/githooks
chmod +x compare/010-validation-stages/githooks/pre-commit
```

husky を使う場合（選択肢）:

```bash
npm install --save-dev husky
npx husky init
cp compare/010-validation-stages/husky-pre-commit .husky/pre-commit
```

測定を取り直す:

```bash
node tools/measure-validate-stages.mjs   # 3 段階の件数と時間
node tools/measure-parser-error.mjs      # 解析の打ち切り
node tools/measure-hook.mjs              # フックがコミットを止めるか
node tools/measure-render.mjs            # ブラウザ表示（3 エンジン）
node tools/measure-extension-modes.mjs   # 拡張機能のローカル導入 / 同梱版
bash tools/measure-cross-os.sh           # Linux / Windows（WSL interop 経由）
```

## OS 別の実測状況

| 環境 | 詳細 | 検出件数（broken / fixed / parser） | フック | 結果ファイル |
|---|---|:--:|:--:|---|
| macOS | 26.5.2 arm64 / Node 24.18.0 / git 2.55.0 | 11 / 0 / 1 | 一致 | `010-cross-os-darwin.json` |
| Linux（Multipass） | Ubuntu 26.04 arm64 / Node 24.18.0 / git 2.53.0 | 11 / 0 / 1 | 一致 | `010-cross-os-linux.json` |
| Linux（WSL2） | Ubuntu 26.04 x86_64 / kernel 6.18.33.1-microsoft-standard-WSL2 | 11 / 0 / 1 | 一致 | `010-cross-os-wsl.json` |
| **Windows** | `node.exe` 24.18.0 / `git.exe` 2.53.0.windows.2（WSL interop 経由） | **11 / 0 / 1** | **一致** | `010-cross-os-windows.json` |
| Linux（CI runner） | `ubuntu-latest` x64 / git 2.54.0 | 11（broken のみ検証） | — | CI run `30195725425` |

「フックが一致」は、壊れた HTML で終了コード 1 かつコミットが作られず、`--no-verify` では終了コード 0 でコミットが作られることを指します。**5 環境で検出件数が行・列まで一致**しました。

### Windows で追加に分かったこと（実測）

| # | 事実 | 確認方法 |
|---|---|---|
| 1 | **Linux で入れた `node_modules` は Windows の `npx` から使えない**。`node_modules/.bin` が POSIX symlink のままで、Windows 用の `.cmd` シムが無い | フックが `'html-validate' は…認識されていません` で失敗。Windows の npm で入れ直すと `html-validate` / `.cmd` / `.ps1` が生成され通る |
| 2 | Windows の git は **LF → CRLF の変換警告**を出す（検出件数には影響しない） | `git.exe add` の出力 |
| 3 | Node を入れた直後のセッションは **Windows の PATH が古いまま**で、フック内の `npx` が解決できない | `where node` が空。PATH を補う経路を通すと解決 |
| 4 | **sshd 経由で入った WSL セッションには Windows の PATH が注入されない** | `/etc/wsl.conf` に `appendWindowsPath=false` が無いのに `$PATH` に `/mnt/c/...` が皆無 |

Windows の VS Code 拡張機能は、WSL 経由では測れません。WSL から `code` で開くと言語サーバーが WSL 側に入るため（[公式](https://code.visualstudio.com/docs/remote/wsl)）、Windows ローカルで測るには「WSL: Reopen in Windows」で切り替える必要があります。**未測定**です。

## 測定にあたっての取り扱い

- [`../../symptoms/010-embedded-errors/broken.html`](../../symptoms/010-embedded-errors/broken.html) は **VS Code 側の実測で行・列を記録済み**のため、バイト同一で保持します（SHA-256 `60ad8297…cfc5db`）。コメントを足すと CSS / JS の診断位置が動く可能性があり、その影響を GUI なしで検証できないためです。
- [`../../symptoms/010-markup-errors/broken.html`](../../symptoms/010-markup-errors/broken.html) は同一行末にコメントを追加しました。追加後も 11 件すべてが `行:列` まで一致することを CLI で確認しています。
- [`../../symptoms/010-parser-error/broken.html`](../../symptoms/010-parser-error/broken.html) は**測定用に新設**しました。記事のコードブロック一覧（11 本）には未登録のため、記事へ載せるかは未確定です。
