# 運用（監視・バックアップ・更新・秘密値の変更）

## 監視

VM 上の cron が次を実行します（Terraform 構築の場合は自動設定。手動構築は [manual-setup.md](manual-setup.md#4-cron)）。

| ジョブ | 間隔 | 内容 | 通知先 |
|---|---|---|---|
| `scripts/monitor.sh` | 10 分 | 全コンテナが running / healthy か、x-webhook-rss が `X_STALE_HOURS` 以内に受信しているか、26 時間以内のバックアップがあるか | `HEALTHCHECK_PING_URL` |
| `scripts/backup.sh` | 毎日 03:30 JST | バックアップの開始・成功・失敗 | `BACKUP_PING_URL` |
| cloud-init の構築スクリプト | 初回起動時 | 構築の成功・失敗（失敗時はログ末尾を送信） | `HEALTHCHECK_PING_URL` |

通知には [Healthchecks.io](https://healthchecks.io/)（無料枠あり）などの「死活監視（dead man's switch）」サービスを使います。
チェックを 2 つ作り、ping URL をそれぞれ `HEALTHCHECK_PING_URL`（期間 10 分 + 猶予 20 分）と `BACKUP_PING_URL`（期間 1 日 + 猶予 2 時間）に設定してください。
**ping が途絶えた場合にも通知されるため、VM ごと止まった場合も検知できます。**

`X_STALE_HOURS`（既定 72）は、追っている X アカウントの投稿頻度より長くしてください。IFTTT の停止・アプレット無効化・トークン不一致を検知するための値です。

ログ:

```bash
sudo tail -n 100 /var/log/freetier-reader-bootstrap.log   # 初回構築
sudo tail -n 100 /var/log/freetier-reader-backup.log
sudo tail -n 100 /var/log/freetier-reader-monitor.log
docker compose logs --tail 100 x-webhook-rss             # 拒否された Webhook（理由付き）もここに出る
```

## バックアップとリストア

- **ローカル**: `${BACKUP_DIR}`（Terraform 構築では `/srv/freetier-reader/backups`、データボリューム上）に 7 世代
- **オフサイト**: OCI Object Storage に `backup_retention_days`（既定 30 日）
- 中身: Miniflux の PostgreSQL ダンプ（`pg_restore -l` で検証済み）と x-webhook-rss の SQLite

リストア（Miniflux と x-webhook-rss を停止してから復元し、整合性チェック後に起動します）:

```bash
cd /opt/freetier-reader
# オフサイトから取得する場合（OCI コンソール or rclone でダウンロードして backups/ に置く）
sudo ./scripts/restore.sh /srv/freetier-reader/backups/20261002T183000Z.tar.gz
```

**月に 1 回はリストアを試してください**（別の VM や手元の Docker で `restore.sh` を実行し、記事とスターが戻ることを確認）。

## 更新

| 対象 | 方法 |
|---|---|
| OS のセキュリティ更新 | unattended-upgrades が毎日自動適用。必要なら 04:30 JST に自動再起動 |
| コンテナイメージ・アプリ | Dependabot の PR を確認してマージ → VM で `sudo ./scripts/update.sh` |
| 自動更新（任意） | Terraform 変数 `auto_update = true` で毎週日曜 04:00 JST に `update.sh` を実行 |

`update.sh` は更新前にバックアップを取り、`docker compose up --wait` が失敗したら直前のコミットに戻して起動し直し、`HEALTHCHECK_PING_URL` に失敗を通知します。

## 秘密値・設定を変更する

| 変更したいもの | 手順 |
|---|---|
| Webhook トークン | `.env` の `X_WEBHOOK_TOKEN` を変更 → `docker compose up -d x-webhook-rss` → IFTTT アプレットの URL を更新 |
| Miniflux 管理者パスワード | Miniflux の設定画面から変更（`ADMIN_PASSWORD` は初回作成時のみ使われる） |
| PostgreSQL パスワード | 下記（`.env` だけ変えると Miniflux が DB に接続できなくなる） |
| Cloudflare Tunnel トークン | Cloudflare で再発行 → `.env` の `CLOUDFLARE_TUNNEL_TOKEN` を変更 → `docker compose up -d cloudflared` |

PostgreSQL パスワードの変更:

```bash
cd /opt/freetier-reader
NEW="$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 32)"
docker compose exec -T postgres psql -U miniflux -d miniflux -c "ALTER USER miniflux WITH PASSWORD '${NEW}';"
sudo sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${NEW}|" .env
docker compose up -d --wait miniflux
```

Terraform で構築した場合、Terraform が生成した値（state）と VM 上の `.env` を一致させるには [terraform.md の「設定を変更する」](terraform.md#設定を変更する) を参照してください。

## 初回構築後の確認チェックリスト（E2E）

実環境でしか確認できない項目です。構築・設定変更のたびに確認してください。

| # | 確認内容 | 期待結果 |
|---|---|---|
| 1 | ブラウザで `https://<host>/` を開く | Cloudflare Access のログイン画面（One-time PIN）→ Miniflux のログイン画面 |
| 2 | 許可していないメールで Access にログイン | 拒否される |
| 3 | `curl -i https://<host>/v1/me`（認証なし） | Access のリダイレクトではなく、Miniflux の `401`（Access がバイパスされている） |
| 4 | `curl -i https://<host>/reader/api/0/user-info` / `https://<host>/fever/` | 同上（Miniflux の応答） |
| 5 | `curl -i https://<host>/settings`（認証なし） | Access のログイン画面へリダイレクト（UI はバイパスされていない） |
| 6 | `curl -i -X POST https://<host>/hook/x/wrong-token` | `404`（x-webhook-rss の応答） |
| 7 | 日本国外の IP（VPN 等）から `/v1/me` | Cloudflare のブロック画面 |
| 8 | IFTTT アプレットを実行（対象アカウントでテスト投稿、または過去投稿で手動実行） | `docker compose logs x-webhook-rss` にエラーがなく、フィードに本文が**記号の欠落なく**表示される（`&` `=` `+` 改行を含む投稿で確認） |
| 9 | Miniflux に rss-bridge（報知）と x-webhook-rss のフィードを追加 | 取得エラーにならない |
| 10 | `sudo ./scripts/backup.sh` → `sudo ./scripts/restore.sh <archive>` | 復元後も記事・スターが残る |
| 11 | Healthchecks.io のダッシュボード | 2 つのチェックが Up |
