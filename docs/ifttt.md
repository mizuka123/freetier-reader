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
4. 保存して有効化

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
docker compose exec x-webhook-rss wget -qO- http://127.0.0.1:8080/healthz
# {"ok":true,"lastReceivedAt":"2026-10-02T13:15:00.000Z"}
```

`lastReceivedAt` が長期間更新されない場合は、IFTTT のアプレット実行履歴（Activity）を確認してください。

## 制約

- リストや検索キーワード単位の取得はできません（IFTTT のトリガーに依存）
- 画像・引用ポストの扱いは限定的です（本文とリンクが中心）
- IFTTT がトリガーを廃止・変更した場合は停止します
