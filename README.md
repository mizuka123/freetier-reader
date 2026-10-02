# freetier-reader

クラウドの無料枠（OCI Always Free / GCP Free Tier など）で動かす、自分専用の RSS リーダー構成です。

- **RSS があるサイト** … そのまま購読、要約だけの RSS は全文を補完
- **RSS がないサイト** … CSS セレクタで記事一覧と本文を抜き出してフィード化
- **X（旧Twitter）** … IFTTT の公式連携で投稿を受け取り、アカウント別フィード化
- **ログイン認証** … Cloudflare Access + Miniflux（パスキー / TOTP）。スマホ・タブレットのアプリは同期 API で初回設定のみ
- **デザイン** … デジタル庁デザインシステムを参考にした画面テーマ（ライト/ダーク、WCAG 2.2 AA のコントラストを CI で検証）
- **IaC** … Terraform で OCI と Cloudflare を一括構築
- **運用** … 毎日のバックアップ（OCI Object Storage へ 30 日）、死活監視（Healthchecks.io 等）、OS 自動更新、失敗時ロールバック付きの更新スクリプト

> English: A self-hosted RSS reader stack for cloud free tiers. Miniflux + RSS-Bridge + an IFTTT-to-Atom bridge for X, published via Cloudflare Tunnel/Access, provisioned with Terraform (OCI + Cloudflare). MIT licensed.

## 構成

```
[PC ブラウザ]  ──HTTPS── Cloudflare Access ──┐
[スマホ/iPad アプリ] ──同期API（Access対象外・WAF）──┤
[IFTTT] ──POST /hook/x/<token>──────────────────┤
                                               Cloudflare Tunnel（受信ポート開放なし）
                                                 │
   ┌──────────── OCI Always Free（Ampere A1）/ Docker Compose ────────────┐
   │ cloudflared → miniflux（UI/API/巡回/全文取得）── postgres            │
   │                 ├─ rss-bridge（RSS のないサイト）                    │
   │                 ├─ x-webhook-rss（IFTTT → アカウント別 Atom、自作）   │
   │                 └─ morss / rsshub（任意）                           │
   └────────────────────────────────────────────────────────────────────┘
```

| コンテナ | 役割 | プロファイル |
|---|---|---|
| miniflux | リーダー本体 | 常時 |
| postgres | Miniflux の DB | 常時 |
| rss-bridge | RSS のないサイトのフィード化 | 常時 |
| x-webhook-rss | IFTTT Webhook → Atom（[services/x-webhook-rss](services/x-webhook-rss)） | `x` |
| cloudflared | Cloudflare Tunnel | `cloudflare` |
| morss | 全文取得の補助 | `morss` |
| rsshub | RSSHub | `rsshub` |

## 必要なもの・費用

| 必要なもの | 費用 |
|---|---|
| Docker が動くサーバ（推奨: OCI Always Free の A1。GCP e2-micro などでも可） | 0 円（Always Free の範囲。予算アラートで監視） |
| Cloudflare で DNS を管理しているドメイン | ドメイン代のみ（Cloudflare は Free プランで可） |
| X 連携を使う場合: IFTTT Pro 以上（Webhooks アクションを使うため） | IFTTT の利用料（**有料**。X 連携を使わなければ不要） |
| 死活監視（任意）: Healthchecks.io など | 0 円（無料枠） |

「月額 0 円」はインフラ（サーバ・ネットワーク・ストレージ）についてです。ドメインと IFTTT は別途必要です。

## クイックスタート

### A. Terraform で OCI + Cloudflare を一括構築（推奨）

```bash
git clone https://github.com/mizuka123/freetier-reader.git
cd freetier-reader/infra/terraform
cp terraform.tfvars.example terraform.tfvars   # 値を編集
export TF_VAR_cloudflare_api_token=...          # docs/terraform.md の権限で発行
terraform init
terraform apply
terraform output -raw admin_password           # 初回ログイン用
terraform output -raw ifttt_webhook_url        # IFTTT に設定
```

詳細: [docs/terraform.md](docs/terraform.md)

### B. 手動構築（任意のサーバ）

```bash
git clone https://github.com/mizuka123/freetier-reader.git
cd freetier-reader
./scripts/init.sh          # .env を作成し秘密値を自動生成
vi .env                    # READER_HOSTNAME / CLOUDFLARE_TUNNEL_TOKEN などを設定
docker compose up -d --build --wait
```

詳細: [docs/manual-setup.md](docs/manual-setup.md)

## ドキュメント

| ドキュメント | 内容 |
|---|---|
| [docs/terraform.md](docs/terraform.md) | Terraform による OCI / Cloudflare 構築 |
| [docs/manual-setup.md](docs/manual-setup.md) | 手動構築（GCP・自宅サーバなど） |
| [docs/ifttt.md](docs/ifttt.md) | IFTTT で X の投稿を受け取る設定 |
| [docs/sources.md](docs/sources.md) | RSS のないサイトのフィード化（例: スポーツ報知） |
| [docs/apps.md](docs/apps.md) | Android / iPhone / iPad / ブラウザでの利用 |
| [docs/theme.md](docs/theme.md) | 画面テーマ（デジタル庁デザインシステム準拠）の適用・カスタマイズ |
| [docs/operations.md](docs/operations.md) | 監視・バックアップ/リストア・更新・秘密値の変更・初回確認チェックリスト |

## 個人設定の管理

このリポジトリには個人の設定値や秘密情報を含めません。`.env`・`terraform.tfvars`・購読リスト（OPML）などは gitignore 済みです。
自分の設定をバージョン管理したい場合は、別の**非公開リポジトリ**で管理することを推奨します。

## 注意事項

- サイトのセレクタ定義はサンプルです。各サイトの利用規約を守り、個人利用の範囲で、巡回間隔を空けて利用してください。
- X の投稿は IFTTT の公式連携で取得します。Cookie の抜き取りなど、X の規約に反する方法は扱いません。
- 利用している OSS（Miniflux: Apache-2.0、RSS-Bridge: Unlicense、morss: AGPL-3.0、RSSHub: MIT）は公式イメージを参照するのみで、コードは同梱していません。
- 画面テーマはデジタル庁デザインシステムを参考にした非公式のものです。デザイントークンの値は @digital-go-jp/design-tokens（MIT License, © 2023 デジタル庁）を使用しています（[themes/dads/LICENSE-design-tokens](themes/dads/LICENSE-design-tokens)）。

## ライセンス

[MIT](LICENSE)
