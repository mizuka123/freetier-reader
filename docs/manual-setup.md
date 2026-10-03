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

1. Settings → Authentication → Login methods に「One-time PIN」を追加（未設定の場合）
2. Access → Applications → Add → Self-hosted
   - ドメイン: `reader.example.com`、セッション時間: 1 month
   - ポリシー: Allow / Include: Emails = 自分のメール
3. もう 1 つ Self-hosted アプリを追加（同期 API と Webhook をバイパス）
   - パス: `/v1/`、`/reader/`、`/fever/`、`/accounts/ClientLogin`、`/hook/x/`（末尾の `/` でパスの境界を区切る）
   - ポリシー: Bypass / Include: Everyone
4. WAF で次を設定（Free プランで可。Terraform の定義は `infra/terraform/modules/cloudflare/main.tf`）
   - Rate limiting rule: 上記 5 パスに 10 秒あたり 150 リクエスト（同一 IP）
   - Custom rule: 同期 API の 4 パス（`/hook/x/` 以外）を日本以外からブロック
5. [operations.md のチェックリスト](operations.md#初回構築後の確認チェックリストe2e) の #1〜#7 で境界を確認

## 3. 起動

```bash
git clone https://github.com/mizuka123/freetier-reader.git
cd freetier-reader
./scripts/init.sh          # 秘密値を生成。手で設定すべき値が残っていれば一覧を表示して終了コード 2
vi .env                    # READER_HOSTNAME, CLOUDFLARE_TUNNEL_TOKEN, X_ALLOWED_USERS などを設定
./scripts/init.sh          # "env is ready" になることを確認
docker compose up -d --build --wait
docker compose ps
```

Cloudflare を使わない場合は `COMPOSE_PROFILES` から `cloudflare` を外し、
前段に HTTPS 終端するリバースプロキシ（Caddy など）を置いてください。

> Miniflux は内部ネットワークへの直接の接続を拒否する設定で動かしています。コンテナ内部のフィード（rss-bridge / x-webhook-rss など）は、
> 許可したホストだけを中継する `fetch-proxy` を通して取得するため、購読時に「プロキシ経由で取得」を有効にしてください
> （忘れても `scripts/update.sh` / `scripts/internal-feeds.sh` が自動で切り替えます。[sources.md](sources.md)）。
> ただし Miniflux にログインできる利用者は、フィードごとの「プロキシ URL」に内部のアドレスを指定してこの制限を回避できます（Miniflux の仕様）。
> そのため、クラウドの VM ではコンテナからメタデータサーバ（169.254.169.254）や内部ネットワークへの通信もファイアウォールで遮断してください
> （Terraform 構築では `infra/terraform/templates/cloud-init.yaml.tftpl` の egress guard が自動設定します）。

## 4. cron

時刻はサーバのタイムゾーン（`timedatectl` で確認）で解釈されます。下の例はサーバが JST の場合です（UTC のサーバなら `30 18 * * *`）。

```cron
# バックアップ: 毎日 03:30 JST
30 3 * * * root /path/to/freetier-reader/scripts/backup.sh >> /var/log/freetier-reader-backup.log 2>&1
# 監視: 10 分ごと（HEALTHCHECK_PING_URL を設定）
*/10 * * * * root /path/to/freetier-reader/scripts/monitor.sh >> /var/log/freetier-reader-monitor.log 2>&1
```

バックアップ・リストア・更新・秘密値の変更は [operations.md](operations.md) を参照してください。

## 5. 更新

```bash
./scripts/update.sh   # バックアップ → git pull → pull/build → up --wait（失敗時は自動ロールバック）
```
