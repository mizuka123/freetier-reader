# IFTTT で X の投稿を受け取る

X のアカウントごとに IFTTT アプレットを 1 つ作り、新しい投稿を `x-webhook-rss` に送ります。
`x-webhook-rss` はアカウント別の Atom フィードを配信し、Miniflux がそれを購読します。

- 必要なプラン: **IFTTT Pro 以上**（Webhooks アクションと、チェック間隔の短縮のため）
- Pro のアクティブアプレット上限は 20（2026 年時点）。追うアカウント数がこれを超える場合は Pro+ が必要

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
最初の投稿が届くまではフィードが空のままです。

## 動作確認

```bash
docker compose exec x-webhook-rss wget -qO- http://127.0.0.1:8080/status
# 受信後: {"ok":true,"stale":false,"lastWebhookAt":"2026-10-02T13:15:00.000Z","since":"2026-10-02T13:15:00.000Z"}
# 受信前: {"ok":true,"stale":false,"lastWebhookAt":null,"since":"<DB 作成時刻>"}
docker compose logs --tail 50 x-webhook-rss   # 拒否された Webhook は理由付きでログに出る
```

- `/status` は、最後に正当な Webhook を受け取ってから（一度も受け取っていなければ DB 作成から）`X_STALE_HOURS`（既定 72）を超えると 503 を返し、`scripts/monitor.sh` が通知します（[operations.md](operations.md#監視)）。
  その場合は IFTTT のアプレット実行履歴（Activity）を確認してください。
- 重複した投稿や古すぎて保存されなかった投稿も「受信」として数えます。
- `/healthz` はプロセスの生存確認（コンテナのヘルスチェック用）で、受信状況には関係なく 200 を返します。

## 制約

- リストや検索キーワード単位の取得はできません（IFTTT のトリガーに依存）
- 画像・引用ポストの扱いは限定的です（本文とリンクが中心）
- IFTTT がトリガーを廃止・変更した場合は停止します
