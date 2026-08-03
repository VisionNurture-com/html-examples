# 009: ネイティブ制約検証のみ / JS 検証併用の実測比較

- 測定日: 2026-07-25
- 対象: [`a-native.html`](a-native.html) / [`b-js.html`](b-js.html)
- 同一要件で実装: お名前（必須）/ メールアドレス（必須・形式）/ 電話番号（半角数字 10〜11 桁）

## 実測値

| 指標 | A: ネイティブのみ | B: JS 併用 | 取得方法 |
|---|---|---|---|
| JS の実行行数 | **0 行** | **21 行** | コードを数える（読者も同じ数を数えられる）|
| ファイル総行数 | 28 行 | 55 行 | `wc -l` |
| Enter（不正時）の submit イベント発火 | **0 回** | **1 回** | `node tools/measure-keyboard.mjs`（chromium / firefox / webkit の 3 エンジンで一致・2026-07-26 追加取得）|
| Enter（正常時）の submit イベント発火 | 1 回 | 1 回 | 同上 |
| html-validate | 0 件 | 0 件 | `npx html-validate --config tools/.htmlvalidate.json` |
| axe violations | 0 件 | **0 件（差なし）** | `node tools/measure-a11y.mjs`（axe-core 4.12.1）|
| エラー文言のカスタマイズ | 不可（ブラウザ既定文言）| 可 | 実機観察 |
| 実機スクリーンリーダー: エラーの読み上げ | 読まれる（ブラウザ既定文言・英語）| 読まれる（作者の文言・日本語）| VoiceOver の読み上げ逐語を取得 |
| 実機スクリーンリーダー: エラー後に同じ欄へ戻った時 | **未測定**（永続するエラー文を持たない）| **文言が読まれる**（`aria-describedby`）| 同上 |

環境: chromium 151.0.7922.34 / Playwright 1.62.0 / html-validate 11.5.6 / axe-core 4.12.1 / macOS 26.5.2

スクリーンリーダーの測定環境: macOS 26.5.2 の VoiceOver × Safari 26.5.2 / Chrome 150.0.7871.182（ブラウザ UI 言語は英語）。逐語の実測値は次のとおりです。

| 実装 | 段階 | Safari | Chrome |
|---|---|---|---|
| A | 未入力送信時 | `In text Fill out this field` | `Please fill out this field.` |
| B | エラー文の挿入時（`aria-live`）| `メールアドレスの形式で入力してください` | 同左 |
| B | エラー後に `name` へ戻った時 | `お名前（必須） お名前を入力してください invalid data edit text with autofill menu` | `お名前（必須） お名前を入力してください invalid data edit text` |

`aria-live` は 3 件同時挿入のため**最後の 1 件で上書き**されます（両ブラウザ共通）。

## 読み取り

**Enter 経路の差が最も本質的です。** A はブラウザが submit イベントの発火自体を止めます。B は `novalidate` でブラウザの検証を切っているため発火し、止めているのは自前の JS です。B の 21 行は「ブラウザが無料でやっていたことを引き取った量」に相当します。

**axe では差が出ません。** どちらも 0 件です。A と B の a11y 上の実差は「エラー文が支援技術に届くか」という質的な点で、axe が測れる範囲の外にあります。axe を通しただけで a11y が担保されるわけではないことの実例になります。

**B を選ぶ理由になるのは文言のカスタマイズだけです。** 文言を自分の言葉にする必要がなければ、21 行を書く理由がありません。

## 数値の再取得

```bash
npm install
npx playwright install chromium firefox webkit
node tools/measure-keyboard.mjs --out tools/results/009-keyboard.json compare/009-native-vs-js-validation/*.html
node tools/measure-keyboard.mjs --engine firefox --out tools/results/009-keyboard-firefox.json compare/009-native-vs-js-validation/*.html
node tools/measure-keyboard.mjs --engine webkit --out tools/results/009-keyboard-webkit.json compare/009-native-vs-js-validation/*.html
node tools/measure-a11y.mjs --out tools/results/009-a11y.json compare/009-native-vs-js-validation/*.html
npm run check:html
```

## 測っていないこと

- **Windows のスクリーンリーダー**（NVDA / ナレーター）。実機環境がないため未検証。macOS の VoiceOver は測定済
- **A 実装でエラー後に同じ欄へ戻った時の読み上げ**。A は永続するエラー文を持たないため段階として測っていない
- Tab 走査そのものの読み上げ。フォーカス移動をアクセシビリティ API で行ったため未測定
