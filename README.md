# mizukure
Check if it's time to water

## 構成

```
スマホ (カメラ) → public/index.html → POST /api/judge (src/worker.js)
                                        ├─ 1. Workers AI 視覚モデル: 写真 → 英語の観察メモ(JSON)
                                        └─ 2. Jev (typesafe.ai /v1/systemone): 観察メモ → 確率付き判定
```

Jev はテキスト専用 (画像入力非対応) のため、写真はまず Workers AI の視覚モデルで観察メモに変換してから Jev に渡します。
端末内で測った土の色 (リアルタイム表示の値) も参考値として Jev に送ります。

Jev に聞いている質問 (`src/worker.js` の `QUESTIONS`):

| id | 種類 | 内容 |
|---|---|---|
| watering_need | score (5段階) | 水やりの緊急度 → 画面の「水やり必要度 %」 |
| wilting | score (4段階) | 萎れ具合 |
| soil_dryness | score (5段階) | 土の乾き具合 |
| overwatered | noul | 水のやりすぎのサイン |
| water_preference | choice | 乾燥好き / 普通 / 水好き / 不明 → アドバイス文の出し分け |
| photo_reliable | noul | 写真で判定できるか (0.3 未満なら「判定できません」) |

## セットアップ

```sh
npm install
npx wrangler secret put TYPESAFE_API_KEY   # typesafe.ai の API キー
npx wrangler deploy
```

ローカル開発: `.dev.vars` に `TYPESAFE_API_KEY=...` を書いて `npm run dev`
(Workers AI はローカルでも Cloudflare 側で実行され、課金対象です)。

視覚モデルは `wrangler.jsonc` の `VISION_MODEL` で差し替えられます
(例: `@cf/google/gemma-4-26b-a4b-it`)。

## テスト

```sh
npm test   # Workers AI と Jev をモックして API の流れを検証
```
