# mizukure

スマホのカメラで植物を写すだけで、水やりどきかどうかをチェックできる Web サービスです。ログイン無しで利用できます。
なお、リポジトリ名の「水くれ」は地元の方言です😛

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

## 自分の Cloudflare にデプロイする (fork した方向け)

所要時間は 15〜20 分ほどです。コードの変更は不要で、ダッシュボードでの設定だけで動きます。

### 0. 必要なもの

| もの | 用途 | 料金の目安 |
|---|---|---|
| GitHub アカウント | このリポジトリを fork し、Cloudflare に接続する | 無料 |
| Cloudflare アカウント | Worker (API + 静的ページ)、Workers AI、Turnstile | Workers AI は 1 日 10,000 Neurons まで無料。超える分を使うには Workers Paid プラン (月 $5〜) が必要 |
| typesafe.ai の API キー | Jev (判定モデル) の呼び出し | typesafe.ai の料金体系に従います |

> **課金について**: 判定 1 回ごとに Workers AI (画像解析) と Jev が 1 回ずつ呼ばれます。
> カメラのリアルタイム表示 (土の色) は端末内だけで計算するので、何回見ても料金はかかりません。
> 使いすぎを防ぐ仕組みは下の「[`/api/judge` の保護](#apijudge-の保護)」を参照してください。

### 1. リポジトリを fork する

GitHub でこのリポジトリを fork します。Worker の名前は `wrangler.jsonc` の `"name"` (既定は `mizukure`) で決まります。
別の名前にしたい場合は、ここで `"name"` を書き換えてコミットしておいてください
(**ダッシュボード上の Worker 名と一致していないと、ビルドが失敗します**)。

### 2. workers.dev のサブドメインを確認する

Cloudflare ダッシュボードの **Workers & Pages** を開き、アカウントの workers.dev サブドメインを確認します
(初めての場合はここで決めます)。デプロイ後の URL は次の形になります。

```
https://<Worker 名>.<サブドメイン>.workers.dev      例: https://mizukure.example.workers.dev
```

このホスト名は次の手順の Turnstile で使います。

### 3. Turnstile ウィジェットを作る

Turnstile は「ロボットではないこと」を確認する Cloudflare の仕組みです。
これがないと、URL を知っている人がスクリプトから `/api/judge` を連打して料金を発生させられます。

1. ダッシュボードの **Turnstile** → **Add widget**
2. 次のように入力します。
   - **Widget name**: 何でも可 (例: `mizukure`)
   - **Hostname management**: 手順 2 のホスト名 (例: `mizukure.example.workers.dev`)。
     独自ドメインでも公開するならそれも追加します。**`localhost` は追加しないでください**
     (ローカル開発ではテスト用キーを使います。後述)。
   - **Widget mode**: **Managed** (推奨)。ほとんどの人には何も表示されず、怪しいアクセスにだけチェックボックスが出ます。
3. **Create** を押し、表示される **Site Key** と **Secret Key** を控えます。

### 4. リポジトリを Worker に接続する (Workers Builds)

1. **Workers & Pages** → **Create** → **Import a repository** → GitHub を連携して fork したリポジトリを選択
2. ビルド設定
   - **Project name / Worker 名**: `wrangler.jsonc` の `"name"` と同じにする (既定 `mizukure`)
   - **Build command**: 空欄のまま (ビルド不要)
   - **Deploy command**: `npx wrangler deploy` (既定値のまま)
   - **Root directory**: 空欄 (リポジトリ直下)
3. **Deploy** を押すと最初のデプロイが走ります。

この時点ではまだシークレットがないので、ページは開けますが判定すると
「サーバーの設定が完了していません」と表示されます。これは想定どおりです (設定が欠けていると判定しない作りです)。

以後は、接続したブランチ (既定 `main`) に push するたびに自動でデプロイされます。

> **プレビュー URL について**: Workers Builds は `main` 以外のブランチをプレビュー版として
> `<別名>-<Worker 名>.<サブドメイン>.workers.dev` のような別のホスト名で公開することがあります。
> このホスト名は手順 3 のウィジェットに登録されていないため、プレビュー版では Turnstile が失敗し判定できません
> (安全側に倒れる動作です)。変更の確認はローカル開発 (後述) で行うか、必要ならそのホスト名をウィジェットに追加してください。

### 5. シークレットを設定する

Worker の **Settings** → **Variables and Secrets** → **Add** で、種類を **Secret** にして次の 3 つを追加します。

| 名前 | 値 | 備考 |
|---|---|---|
| `TYPESAFE_API_KEY` | typesafe.ai の API キー | Jev の呼び出しに使う |
| `TURNSTILE_SITE_KEY` | 手順 3 の Site Key | 公開情報ですが、Secret Key と同じ場所で管理するためシークレットにしています |
| `TURNSTILE_SECRET` | 手順 3 の Secret Key | 絶対に公開しないこと |

保存すると新しいバージョンがデプロイされます。

> **設定場所に注意**: Worker の **Settings → Builds** にある「Build variables and secrets」は、
> ビルド中にだけ使われる値で、動いている Worker には渡りません。3 つとも必ずここ
> (**Settings → Variables and Secrets**) に設定してください。

> **注意**: 「Variables (平文)」ではなく必ず **Secret** として追加してください。
> `wrangler.jsonc` の `vars` にない平文の変数は、次の `wrangler deploy` (= 次の push) で消えます。シークレットは消えません。

<details>
<summary>ダッシュボードではなく CLI で設定する場合</summary>

```sh
npm ci
npx wrangler login
npx wrangler secret put TYPESAFE_API_KEY
npx wrangler secret put TURNSTILE_SITE_KEY
npx wrangler secret put TURNSTILE_SECRET
npx wrangler deploy        # Workers Builds を使わない場合のみ
```

</details>

### 6. 動作確認

1. `https://<Worker 名>.<サブドメイン>.workers.dev/api/health` を開き、すべて `true` になっていることを確認します。

   ```json
   {"ok":true,"jev":true,"ai":true,"turnstile":true,"rate_limit":true}
   ```

   `ok` は判定に必要な設定がすべて揃っているときだけ `true` です。
   `false` の項目があれば、その設定が足りていません (`jev` → `TYPESAFE_API_KEY`、`turnstile` → Turnstile の 2 つ、
   `ai` / `rate_limit` → `wrangler.jsonc` のバインディング)。
2. スマホでトップページを開き、カメラを許可して植物と土を写し、「この植物を判定」を押します。

### 7. (任意) 調整できる設定

| 設定 | 場所 | 既定値 | 説明 |
|---|---|---|---|
| レート制限の回数 | `wrangler.jsonc` の `ratelimits` の `simple` | `PRECHECK_LIMITER` 60 秒に 60 回、`JUDGE_LIMITER` 60 秒に 10 回 | `period` は 10 か 60 (秒) のみ指定可能。有料 API の回数を決めるのは `JUDGE_LIMITER` |
| レート制限の名前空間 | `wrangler.jsonc` の `ratelimits` の `namespace_id` | `"1002"`, `"1001"` | アカウント内で一意な整数の文字列。同じアカウントの別 Worker が同じ値を使うとカウンタを共有してしまうので、その場合は変更する |
| 視覚モデル | `wrangler.jsonc` の `vars.VISION_MODEL` | `@cf/meta/llama-4-scout-17b-16e-instruct` | **画像入力と JSON スキーマ出力 (`response_format`) の両方に対応した** Workers AI のモデルなら差し替え可 (候補: `@cf/google/gemma-4-26b-a4b-it`)。一部のモデルは Workers Paid プランが必要。変更後は実際に 1 回判定して確認してください |
| Jev のモデル | `wrangler.jsonc` の `vars.JEV_MODEL` | `jev-latest` | |
| 独自ドメイン | Worker の **Settings** → **Domains & Routes** | なし | 追加したら Turnstile ウィジェットの Hostname にも追加する |

`wrangler.jsonc` を変更したら、コミットして push すれば反映されます。

## `/api/judge` の保護

判定 1 回ごとに Workers AI と Jev の料金がかかるため、`/api/judge` は次の順にチェックし、
すべて通ったリクエストだけが有料 API を呼びます。

1. **Origin チェック**: 自分のページ以外から (または Origin ヘッダーなしで) 送られたリクエストは 403。
   ブラウザからの POST には必ず Origin が付きます。
2. **設定チェック**: シークレットやバインディングが 1 つでも欠けていれば 500 `not_configured` (判定しない)。
3. **ゆるいレート制限** (`PRECHECK_LIMITER`、60 秒 60 回): トークン付きのリクエストをすべて数えます
   (トークンのないリクエストは、ここに来る前に 403)。
   不正なトークンを大量に送りつけられても、次の Turnstile の検証に回す数をここで抑えます。
4. **Turnstile の検証**: ページは Turnstile のトークンを `X-Turnstile-Token` ヘッダーで送り、サーバー側で検証します
   (5 秒でタイムアウト)。写真を読み込む前に行います。トークンがない・不正なら 403。
   Cloudflare 側の障害や `TURNSTILE_SECRET` の値の誤りなら 503。
5. **本文と写真のチェック**: 本文は読みながらバイト数を数え、上限を超えた時点で 413。
   画像は JPEG / PNG / WebP の 4 MB まで (それ以外は 415 / 413)。
6. **厳しいレート制限** (`JUDGE_LIMITER`、60 秒 10 回): Turnstile を通り、写真も正しいリクエスト
   (= これから有料 API を呼ぶもの) だけを数えます。有料 API の呼び出し回数の上限です。
   不正なトークンや使えない写真はここでは数えないので、同じ IP (携帯回線の共有 IP など) の利用者の
   回数を少しの不正リクエストで使い切られることはありません
   (ただし 3 のゆるい制限を超えるほど大量に送られると、その IP からは一時的に判定できなくなります)。

レート制限はどちらも IPv4 はアドレス単位、IPv6 は /64 単位で、超えると 429、レート制限自体が失敗すると 503 です。
Cloudflare の拠点ごとの概算で、アカウント全体の利用上限ではありません。

これらは「有料 API の呼び出し」を守る仕組みです。不正なトークン付きのリクエストを大量に送りつけられた場合、
有料 API は呼ばれませんが Worker のリクエスト数 (Free プランは 1 日 10 万回) は消費されます。
心配な場合は、Cloudflare の WAF で `/api/judge` に IP 単位のレート制限ルールを追加してください
(独自ドメインで公開している場合に設定できます)。

ページ側では、判定中はボタンを無効にして二重送信を防いでいます。Turnstile のトークンはページを開いたとき・各判定の後・タブに戻ったときに先に取得しておき (有効期限 300 秒のため、4 分を過ぎたものは取り直します)、判定時の待ち時間を減らしています。Turnstile がチェックボックスを
出した場合 (まれです) は、画面にその旨を表示してチェックボックスまでスクロールします。

## ローカル開発

```sh
npm ci
npx wrangler login     # Workers AI はローカル実行時も Cloudflare 側で動くため必要
```

`.dev.vars` (git 管理外) を作ります。Turnstile は Cloudflare 公式の**テスト用キー** (常に成功する) を使います。

```
TYPESAFE_API_KEY=...
TURNSTILE_SITE_KEY=1x00000000000000000000AA
TURNSTILE_SECRET=1x0000000000000000000000000000000AA
```

```sh
npm run dev            # http://localhost:8787
```

- Workers AI と Jev はローカルでも実際に呼ばれ、**課金対象**です。
- テスト用キーは `localhost` / `127.0.0.1` / `[::1]` からのアクセスでのみ通ります
  (同じ LAN のスマホから `http://192.168.x.x:8787` で開いた場合は Turnstile が失敗します)。
  **本番のシークレットにテスト用キーを設定しないでください** (本番では常に失敗し、判定できなくなります)。

## トラブルシューティング

| 画面の表示 / 症状 | 原因と対処 |
|---|---|
| サーバーの設定が完了していません | シークレットかバインディングが不足。`/api/health` で `false` の項目を確認 (手順 5・6) |
| ロボットでないことの確認に失敗しました | Turnstile の Hostname に今開いているドメインが入っていない、Site Key / Secret Key が別々のウィジェットのもの、本番にテスト用キーを設定した (ログに `turnstile token for another host`)、広告ブロッカーが `challenges.cloudflare.com` を遮断している、またはページ読み込み時に `/api/config` を取得できなかった (電波状況) |
| このページからは判定できません | 別のドメインや、Origin を付けないクライアントからのアクセス。`https://<Worker 名>.<サブドメイン>.workers.dev` (または設定した独自ドメイン) から開く |
| 判定の回数が多すぎます | この Worker のレート制限 (判定は 60 秒 10 回)。少し待つ。回数は手順 7 で調整可 |
| サーバーが一時的に利用できません | 原因は Worker のログで見分けられます。`turnstile siteverify refused our request` → `TURNSTILE_SECRET` の値が間違っている。`jev failed` (Jev 429/529) → Jev が混雑・利用制限中。それ以外は Cloudflare 側 (レート制限・Turnstile 検証) の一時的な障害なので、時間をおいて再試行 |
| 判定サーバーに接続できませんでした | Jev の呼び出しに失敗。`TYPESAFE_API_KEY` が正しいか確認 |
| 写真の解析に失敗しました | Workers AI の呼び出しに失敗。無料枠 (1 日 10,000 Neurons) の使い切り、または `VISION_MODEL` が Workers Paid プラン専用の可能性 |
| 写真が大きすぎます | 端末で縮小しても 4 MB を超える写真。別の写真で試すか、カメラの解像度を下げる |
| 判定結果を読み取れませんでした | Worker が JSON 以外 (Cloudflare のエラーページ) を返した。Worker の **Observability** のログで例外を確認 |
| 通信に失敗しました | 上記以外の失敗 (端末のネットワーク切断など)。電波状況を確認して再試行 |
| プレビュー URL でだけ判定できない | 手順 4 の「プレビュー URL について」を参照 |
| ビルドが失敗する (Workers Builds) | ダッシュボードの Worker 名と `wrangler.jsonc` の `"name"` が一致しているか確認 |

ログは Worker の **Observability** (ログ) で確認できます (`wrangler.jsonc` で有効化済み)。

### 判定の所要時間

`/api/judge` の応答には `Server-Timing` ヘッダーが付き、Turnstile を通ったリクエストは同じ値が Observability のログにも 1 行の JSON で出ます (数値は例)。

```json
{"judge":{"status":200,"ms":{"turnstile":85,"upload":240,"vision":3900,"jev":1400,"total":5650}}}
```

| 項目 | 内容 |
|---|---|
| `turnstile` | Turnstile トークンの検証 (siteverify) |
| `upload` | Turnstile の検証が終わってから、写真を受け取り終えるまで。写真は検証中にも届き始めるので、受信にかかった時間の全体ではない (端末の回線速度に左右される) |
| `vision` | Workers AI の視覚モデル |
| `jev` | Jev の呼び出し (429/529 の再試行を含む) |
| `total` | Worker がリクエストを受けてから応答するまで |

レート制限の確認などは個別の項目に含まれないため、各項目の合計は `total` より少し小さくなります。
途中で断ったリクエストは、そこまでの項目と `total` だけが出ます。ブラウザの開発者ツール (Network → Timing) でも確認できます。

## テスト

```sh
npm test   # Workers AI・Jev・Turnstile・レート制限をモックして API の流れを検証
```

## AI エージェント用サンドボックス (pall8t)

[pall8t](https://github.com/TakiTake/pall8t) で apple/container の VM 内でエージェントを動かせます
(`.pall8t/Containerfile` = Node 22 + claude + gh、`hardening = "strict"`)。

```sh
pall8t run                                   # サンドボックス内で claude を起動
pall8t run -- bash -c 'npm ci && npm test'   # テストだけ実行
```

ワークスペースはエージェントから読めるので、`.dev.vars` (TYPESAFE_API_KEY) は置かない方が安全です。
デプロイは Workers Builds (git push) に任せ、サンドボックスには Cloudflare の認証情報を入れない想定です。
