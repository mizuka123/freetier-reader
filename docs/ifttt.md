# IFTTT で X の投稿を受け取る

X のアカウントごとに IFTTT アプレットを 1 つ作り、新しい投稿を `x-webhook-rss` に送ります
（複数のアカウントを 1 つのアプレットにまとめる方法は [2b](#2b-検索トリガーで複数アカウントをまとめる) を参照）。
`x-webhook-rss` はアカウント別の Atom フィードを配信し、Miniflux がそれを購読します。

- 必要なプラン: **IFTTT Pro 以上**（Webhooks アクションと、チェック間隔の短縮のため）
- 2026-10-28 から IFTTT はクレジット制になり、アプレット数の上限はなくなりました。アプレットが動くたびに月ごとのクレジットを消費し、使い切ると翌月まで（またはクレジットを追加するまで）アプレットが止まります。超過料金はかかりません
- 1 回の実行で消費するクレジットは公開されていません。数日動かして IFTTT の画面で残りクレジットの減り方を確認し、追うアカウントの数を決めてください

## 1. Webhook URL を確認

```bash
# Terraform の場合
terraform -chdir=infra/terraform output -raw ifttt_webhook_url
# 手動構築の場合
echo "https://${READER_HOSTNAME}/hook/x/${X_WEBHOOK_TOKEN}"
```

この URL は**パスワードと同じ扱い**です。漏れた場合は `X_WEBHOOK_TOKEN` を変えて再起動し、アプレットを更新してください。

## 2. アプレットを作る（アカウントごと）

1. IFTTT → Create
2. **If This**: X (Twitter) → 「New tweet by a specific user」→ ユーザー名を入力（@ なし）
3. **Then That**: Webhooks → 「Make a web request」
   | 項目 | 値 |
   |---|---|
   | URL | 上の Webhook URL |
   | Method | `POST` |
   | Content Type | `application/x-www-form-urlencoded` |
   | Body | 下記 |

   ```
   username=<<<{{UserName}}>>>&text=<<<{{Text}}>>>&link=<<<{{LinkToTweet}}>>>&created_at=<<<{{CreatedAt}}>>>
   ```

   `<<< >>>` で囲むと IFTTT が値を URL エンコードします（本文に `&` や改行があっても壊れません）。
   万一 `<<< >>>` が記号のまま届いた場合も、x-webhook-rss が外側の記号を取り除きます。
4. 保存して有効化
5. **エンコードの確認**（初回のみ）: `&` `=` `+` と改行を含む投稿がフィードに欠落なく表示されることを確認してください
   （[operations.md のチェックリスト #8](operations.md#初回構築後の確認チェックリストe2e)）。
   欠落する場合は Content Type を `application/json`、Body を次にしてください:

   ```
   {"username":"{{UserName}}","text":"{{Text}}","link":"{{LinkToTweet}}","created_at":"{{CreatedAt}}"}
   ```

   ただし JSON 形式は本文に `"` があると壊れるため、form 形式が動く場合は form 形式を使ってください。

## 2b. 検索トリガーで複数アカウントをまとめる

「New tweet from search」トリガーに `from:` の検索条件を書くと、複数のアカウントの投稿を 1 つのアプレットで受け取れます。
`x-webhook-rss` は届いた投稿のユーザー名（`{{UserName}}`）でフィードを分けるので、サービス側の設定変更は不要です。フィードは今までどおりアカウント別になります。

**クレジットの節約にはなりません。** アプレットは投稿 1 件ごとに 1 回動くため、実行回数は 2 の方法と同じです。
減らせるのはアプレットの数（作成・管理の手間）だけです。

1. IFTTT → Create
2. **If This**: X (Twitter) → 「New tweet from search」→ Search for に次のように入力（@ なし、`OR` は大文字）

   ```
   from:example_user1 OR from:example_user2 OR from:example_user3
   ```

   - リプライを除くには末尾に ` -filter:replies`、リポストを除くには ` -filter:retweets` を付けます（X の検索演算子。IFTTT 側で効くかは初回に確認してください）
   - 1 つの検索条件に入れるのは数アカウントまでにしてください。長すぎると動かないことがあります。多い場合はアプレットを分けます
3. **Then That**: 2 の手順 3 と同じ（Webhooks → 「Make a web request」、URL・Method・Content Type・Body も同じ）
4. 保存して有効化し、2 の手順 5 と同じくエンコードを確認します
5. 検索条件に入れたアカウントを、すべて `X_ALLOWED_USERS`（[3](#3-受け付けるアカウントを制限する)）に追加し、[4](#4-miniflux-で購読する) の手順でアカウントごとに購読します

注意:

- 検索トリガーは X の検索結果に依存します。X の検索に出ない投稿（鍵アカウント、X が検索から外した投稿など）は届きません。取りこぼしが困るアカウントは 2 の「New tweet by a specific user」で個別に作ってください
- 同じアカウントを 2 と 2b の両方に入れると、同じ投稿で 2 回実行されてクレジットを余分に消費します（フィードには 1 件だけ保存されます）。どちらか一方にしてください
- 届かなくなったときの調査は今までと同じで、`/status` の `staleUsers` に出たアカウントを含むアプレットの実行履歴（Activity）を確認します

## 3. 受け付けるアカウントを制限する

`.env` の `X_ALLOWED_USERS` に、アプレットを作ったアカウントをカンマ区切りで設定します（大文字小文字は区別しない）。
空にするとすべて受け付けます。

```
X_ALLOWED_USERS=example_user1,example_user2
```

## 4. Miniflux で購読する

フィード URL（Miniflux から Docker 内部ネットワーク経由でアクセス）:

```
http://x-webhook-rss:8080/feeds/x/<ユーザー名（小文字）>.xml
```

Miniflux → フィード → 追加 で上記 URL を入力し、カテゴリ「X」に入れます。
「詳細オプション」の「プロキシ経由で取得」（Fetch via proxy）を有効にしてください（内部のフィードは `fetch-proxy` 経由でしか取得できません。詳細は [sources.md](sources.md)）。
最初の投稿が届くまではフィードが空のままです。

## リンクカードの画像

IFTTT のトリガーは投稿の画像を渡せない（受け取れるのは本文・ユーザー名・投稿の URL・埋め込みコード・日時だけ）ため、
x-webhook-rss は本文のリンク（`https://t.co/...`）の先のページから `og:image` を取得し、フィードの本文に画像として入れます。
X で表示されるリンクカードの画像と同じものです。

- 取得は投稿を受け取った後に 1 件ずつ行います（IFTTT への応答は待たせません）。起動時には、まだ取得していない投稿も処理します
- 投稿に添付した写真・動画（リンク先が x.com のページ）は、ログインなしでは取得できないため対象外です
- 内部ネットワーク・ループバック・リンクローカル（OCI のメタデータを含む）のアドレス、80 / 443 以外のポートには接続しません（リダイレクト先も同様）。1 つのリンクにつき 8 秒・1 MB・リダイレクト 5 回までです
- 取得に失敗した投稿は画像なしのままにし、何度も取りに行きません
- 画像の URL は 2,048 文字まで、http(s)・80 / 443 のみで、内部向けの URL（内部 IP の直接指定、`miniflux` のようなドットのないホスト名）は使いません
- 画像はリンク先のサイトが指定したものです。表示のたびに画像の配信元へ取得が発生するため、記事を開いたことが配信元に伝わる場合があります（Miniflux 経由で取得するため、閲覧者の IP は伝わりません）
- 無効にするには `.env` の `X_LINK_PREVIEW=false` にして `docker compose up -d x-webhook-rss`

## 動作確認

```bash
docker compose exec x-webhook-rss wget -qO- http://127.0.0.1:8080/status
# {"ok":true,"stale":false,"staleUsers":[],"lastWebhookAt":"2026-10-02T13:15:00.000Z",
#  "users":{"example_user1":"2026-10-02T13:15:00.000Z","example_user2":"2026-10-01T22:00:00.000Z"},
#  "createdAt":"2026-10-01T00:00:00.000Z"}
docker compose logs --tail 50 x-webhook-rss   # 拒否された Webhook は理由付きでログに出る
```

- `/status` は `X_ALLOWED_USERS` の**アカウントごと**に、最後に正当な Webhook を受け取ってから（一度も受け取っていなければ DB 作成から）`X_STALE_HOURS`（既定 72）を超えたかを判定し、1 つでも超えていれば 503 と `staleUsers` を返します。`scripts/monitor.sh` がその内容を通知します（[operations.md](operations.md#監視)）。
  その場合は該当アカウントの IFTTT アプレットの実行履歴（Activity）を確認してください。
- `X_ALLOWED_USERS` が空の場合は、全アカウント合計の最終受信で判定します。
- 投稿頻度が低いアカウントがある場合は、`X_STALE_HOURS` をそのアカウントの投稿間隔より長くしてください。
- 重複した投稿や古すぎて保存されなかった投稿も「受信」として数えます。
- `/healthz` はプロセスの生存確認（コンテナのヘルスチェック用）で、受信状況には関係なく 200 を返します。

## 制約

- リスト単位の取得はできません（IFTTT のトリガーに依存）。検索トリガーは使えますが、フィードは投稿者のアカウント別になります（キーワード別のフィードは作れません）
- 複数の投稿をまとめて 1 回で受け取る方法はありません（IFTTT の X のトリガーは投稿 1 件ごとに動き、投稿の一覧を返すクエリもないため）
- 画像・引用ポストの扱いは限定的です（本文とリンクが中心）
- IFTTT がトリガーを廃止・変更した場合は停止します
