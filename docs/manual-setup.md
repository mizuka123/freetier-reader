# 手動構築（GCP・自宅サーバ・他の VPS など）

Docker と Docker Compose が動く Linux サーバならどこでも構築できます（arm64 / amd64 両対応）。

> GCP の e2-micro（メモリ 1GB）でも基本構成（miniflux + postgres + rss-bridge + x-webhook-rss + cloudflared）は動きますが、
> `rsshub` は重いので有効にしないでください。スワップの設定を推奨します。

## 1. Cloudflare Tunnel を作る

1. Cloudflare Zero Trust → Networks → Tunnels → Create a tunnel（cloudflared）
2. トークンを控える（`CLOUDFLARE_TUNNEL_TOKEN`）
3. Public Hostname を 2 つ追加（**上から順に評価されるので順番が重要**）
   | Hostname | Path | Service |
   |---|---|---|
   | reader.example.com | `^/hook/x/` | `http://x-webhook-rss:8080` |
   | reader.example.com | （空） | `http://miniflux:8080` |

## 2. Cloudflare Access を設定する

1. Access → Applications → Add → Self-hosted
   - ドメイン: `reader.example.com`、セッション時間: 1 month
   - ポリシー: Allow / Include: Emails = 自分のメール
2. もう 1 つ Self-hosted アプリを追加（同期 API と Webhook をバイパス）
   - パス: `/v1`、`/reader`、`/accounts/ClientLogin`、`/fever`、`/hook/x`
   - ポリシー: Bypass / Include: Everyone
3. （推奨）WAF → Rate limiting rules と Custom rules で、同期 API パスにレート制限と国別制限を設定（[terraform.md](terraform.md) の Terraform 定義が参考になります）

## 3. 起動

```bash
git clone https://github.com/mizuka123/freetier-reader.git
cd freetier-reader
./scripts/init.sh
vi .env   # READER_HOSTNAME, CLOUDFLARE_TUNNEL_TOKEN, X_ALLOWED_USERS を設定
docker compose up -d
docker compose ps
```

Cloudflare を使わない場合は `COMPOSE_PROFILES` から `cloudflare` を外し、
前段に HTTPS 終端するリバースプロキシ（Caddy など）を置いてください。

## 4. バックアップ

```bash
./scripts/backup.sh                     # backups/ に保存（7 世代）
# cron 例: 毎日 03:30
# 30 3 * * * /path/to/freetier-reader/scripts/backup.sh
```

リストア:

```bash
tar -xzf backups/<stamp>.tar.gz -C /tmp
docker compose exec -T postgres pg_restore -U miniflux -d miniflux --clean < /tmp/<stamp>/miniflux.dump
docker compose cp /tmp/<stamp>/x-webhook-rss.db x-webhook-rss:/data/x-webhook-rss.db
docker compose restart x-webhook-rss
```

## 5. 更新

```bash
git pull
docker compose pull
docker compose up -d
```
