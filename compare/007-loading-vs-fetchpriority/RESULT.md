# 実測結果 — loading と fetchpriority

同じ 5 実装を、**競合リソースのないページ**と**あるページ**の両方で測りました。数値の出所は `tools/results/007-*.json` です。

## 測定条件

| 項目 | 値 |
|---|---|
| 実施日 | 2026-07-27 |
| ブラウザ | chromium 151.0.7922.34（Playwright 1.62.0 / headless）|
| 帯域 | 1.6 Mbps（サーバ側の共有トークンバケット）|
| 応答遅延 | 150 ms |
| CPU | 4 倍のスロットリング |
| ビューポート | 1280 × 800 |
| 試行 | 各 5 回・中央値 |
| 主役の画像 | `images/hero.jpg` 431,562 バイト（1600×900 / 表示 960×540）|
| 競合リソース | `assets/heavy.css` 183,010 バイト + `assets/heavy.js` 85,985 バイト |

**Lighthouse は使っていません。** `simulate`（Lantern 推定）法は遅延読み込み画像の CLS を取りこぼすためです。

**CDP の `Network.emulateNetworkConditions` も使っていません。** 本環境では、これを有効にすると帯域の強弱と無関係に画像が LCP 候補として記録されなくなります。切り分けの記録は `tools/results/007-lcp-harness-probe.json` にあります。

## 1. ブラウザが割り当てた優先度

`Network.requestWillBeSent` の `initialPriority` です。

| 実装 | hero.jpg | thumb-1〜3 |
|---|---|---|
| A 属性なし | **Medium** | Medium |
| B 主役に `fetchpriority="high"` | **High** | Medium |
| C 4 枚すべてに `fetchpriority="high"` | **High** | **High** |
| D `<link rel="preload">` | **High** | Medium |
| E 全画像に `loading="lazy"` | **Low** | Low |

読み取り。

- `fetchpriority="high"` は主役の優先度を Medium から High へ上げます。
- `<link rel="preload">` も同じく High へ上げます。**優先度の観点では両者は同等**です。
- 4 枚すべてに付けると 4 枚とも High になります。上がらないのではなく、**相対的な優劣が消えます**。
- `loading="lazy"` は主役を **Low** へ落とします。

## 2. LCP と CLS

| 実装 | 競合なし LCP | 競合あり LCP | CLS | LCP 要素 |
|---|---:|---:|---:|---|
| A 属性なし | 4196 ms | 5520 ms | 0 | 主役の画像 |
| B fetchpriority 1 枚 | 4180 ms | 5512 ms | 0 | 主役の画像 |
| C 4 枚すべて high | 4212 ms | 5516 ms | 0 | 主役の画像 |
| D preload | 4204 ms | 5532 ms | 0 | 主役の画像 |
| **E 全画像に lazy** | **312 ms** | **3220 ms** | 0 | **h1（画像ではない）** |

読み取り。

- 競合リソースの有無は効きます（4196 → 5520 ms）。
- **A から D の差は誤差の範囲です。** 優先度は変わっているのに、到着時刻は変わりません。
- 🔴 **E の数値は「速くなった」ではありません。** 主役の画像が遅延されて LCP 要素が `h1` にすり替わっただけで、画像は表示されていません。指標だけを見て判断すると逆の結論になります。

### なぜ A〜D に差が出なかったのか

本ハーネスのサーバは、共有帯域を全接続へ**均等に**配分します。優先度に応じて配分を変える経路がないため、優先度が変わっても到着時刻は変わりません。

到着時刻に差が出るのは、**帯域の配分が優先度に従う場合**（HTTP/2 の優先度、接続数制限による送出順の後回し 等）です。本結果は「`fetchpriority` は無意味」ではなく、**「優先度は上がる。到着が早くなるかは配信側の条件で決まる」**と読んでください。

## 3. `width` / `height` と CLS

`symptoms/007-layout-shift/` の 2 ファイルです。

| 実装 | CLS | LCP |
|---:|---:|---:|
| broken（`width`/`height` なし）| **0.0167** | 2432 ms |
| fixed（`width`/`height` あり）| **0** | 2444 ms |

寸法を書くと、画像が届いたときのずれが消えます。LCP は変わりません（**寸法は CLS に効き、LCP には効かない**）。

## 再取得

```bash
npm install
npx playwright install chromium
node tools/measure-cwv.mjs --runs 5        # LCP / CLS
node tools/measure-cwv.mjs --mode priority # 優先度
```
