# html-examples

HTML の「動かない」を再現し、直し、実装の選択を実測で比べるサンプル集です。

記事シリーズ **HTML basics**（[visionnurture.com](https://www.visionnurture.com/)）の伴走リポジトリです。

## このリポジトリの位置づけ

**記事が正本で、このリポジトリは従です。** コードは記事本文に全文掲載されており、GitHub を開かなくても読めます。ここにあるのはそれと同一内容で、コピーと追試、そして実測値の出所を担います。

- リポジトリ側にだけ存在するコードは置きません
- 記事に載っていないファイルが追試に必要な状態は、記事の自己完結の違反として扱います

## ディレクトリ

| パス | 内容 |
|---|---|
| `symptoms/<記事番号>-<症状>/` | 症状の再現（`broken.html`）と修正（`fixed.html`）。1 ファイルで完結し、ブラウザで開けば動きます |
| `compare/<記事番号>-<比較名>/` | A 実装と B 実装。判断の根拠になる実測値を `RESULT.md` に置きます |
| `tools/` | 計測ハーネス。記事に載る数値はすべてここから出ます |
| `tools/results/` | 実測値（JSON）。記事はこれを引用します |

## 動かす

`symptoms/` と `compare/` はビルド不要です。ファイルをブラウザで開いてください。

```bash
open symptoms/009-required-novalidate/broken.html
```

## 測る

計測には Node.js 20 以上と Playwright のブラウザが必要です。

```bash
npm install
npx playwright install chromium firefox webkit
```

| コマンド | 測るもの |
|---|---|
| `node tools/measure-validation.mjs` | 制約検証 API の挙動（3 エンジン × 2 ロケールを一括）|
| `node tools/measure-validation.mjs --engine chromium --locale ja-JP` | 条件を絞って測る |
| `node tools/measure-ui-language.mjs --ui-locale ja-JP` | ブラウザ UI を日本語にしたときの検証メッセージ |
| `node tools/measure-shadow-boundary.mjs` | Shadow DOM の 3 症状（CSS が届かない / slot が出ない / 中身が空）|
| `node tools/measure-style-boundary.mjs` | 境界を越えるもの（継承 / 変数 / `::part` / `:host` / 外部 CSS）|
| `node tools/measure-upgrade-timing.mjs` | `connectedCallback` の直し方 5 通りのうちどれが効くか |
| `node tools/measure-bundle.mjs` | バンドルサイズ・初期化時間・依存数（Web Components 版 ⟷ React 版）|
| `node tools/measure-react-interop.mjs` | React から独自要素への値とイベントの渡り方 |
| `npx html-validate <file>` | HTML の妥当性 |

> `measure-bundle.mjs` と `measure-react-interop.mjs` は `compare/008-*` 配下の**別パッケージ**をビルドします。依存の導入は各ハーネスが行うため、上記のコマンドをそのまま実行できます（初回のみ時間がかかります）。

## 測定の設計方針

**条件軸を分けて測ります。** エンジンを 1 つしか測らなければ「ブラウザ間で同じ」とも「ブラウザによって違う」とも言えません。ロケールを 1 つしか測らなければ、文言の差をエンジン差へ誤って帰属させます。

結果ファイルには**エンジン名・ブラウザ版・ロケール**を各レコードに入れています。どの条件で測ったのかを結果ファイル自身から検算できるようにするためです。

測れなかった項目は数値を書かず、測れなかったこととして残します。

## ライセンス

MIT（[LICENSE](LICENSE)）
