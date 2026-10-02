# Terraform による構築（OCI + Cloudflare）

`infra/terraform` を 1 回 `apply` すると、次がすべて作られます。

| 対象 | 作成されるもの |
|---|---|
| OCI | VCN / サブネット / インターネットゲートウェイ / セキュリティリスト（受信全閉） |
| OCI | Ampere A1 VM（Ubuntu 24.04）。cloud-init で Docker 導入 → clone → `docker compose up -d` |
| OCI | バックアップ用 Object Storage バケット（7 日で自動削除）と VM 用の最小権限 |
| OCI | 月次予算と、実績が発生したら通知するアラート |
| Cloudflare | Tunnel・DNS（CNAME）・Access（UI は許可メールのみ、同期 API と Webhook はバイパス）・WAF（レート制限、国別制限） |
| 共通 | 管理者パスワード・DB パスワード・Webhook トークンの自動生成 |

## 1. 事前準備

### OCI
1. OCI アカウントを作成し、**Pay As You Go にアップグレード**（Always Free の範囲は無料のまま。アイドル回収と A1 在庫切れの対策）
2. API キーを作成し `~/.oci/config` を設定（OCI コンソール → プロファイル → API キー → 「構成ファイルのプレビュー」）
3. テナンシ OCID を控える

### Cloudflare
1. ドメインを Cloudflare に追加（Free プランで可）
2. Zero Trust を有効化（Free プラン、50 ユーザーまで無料）
3. API トークンを作成（「カスタムトークン」）。必要な権限:
   - Account: `Cloudflare Tunnel: Edit`、`Access: Apps and Policies: Edit`
   - Zone: `DNS: Edit`、`Zone WAF: Edit`
4. アカウント ID とゾーン ID を控える（ダッシュボードのドメイン概要ページ右下）

### ツール
- Terraform 1.6 以上

## 2. 実行

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars
# terraform.tfvars を編集
export TF_VAR_cloudflare_api_token=xxxxxxxx
terraform init
terraform plan
terraform apply
```

完了後、VM の起動と cloud-init の完了まで 5〜10 分ほどかかります。

```bash
terraform output reader_url
terraform output -raw admin_password
terraform output -raw ifttt_webhook_url
```

## 3. 初回ログイン後にやること

1. `reader_url` を開き、Cloudflare Access（メールのワンタイムコード）→ Miniflux に `admin` / `admin_password` でログイン
2. 設定 → パスキーを登録（各端末で）。必要なら TOTP も有効化
3. 設定 → 連携 → Google Reader API / Fever API を有効化し、アプリ用のユーザー名・パスワードを設定（[apps.md](apps.md)）
4. 設定 → API キーを端末ごとに発行（Miniflux API 対応アプリ用）

## よくある問題

| 症状 | 対処 |
|---|---|
| `Out of host capacity`（A1 の在庫切れ） | 時間をおいて再実行 / `availability_domain_index` を変える / PAYG にアップグレード |
| `cloudflare_ruleset` が既存ルールと衝突 | そのゾーンに既に同じフェーズのルールセットがある。`terraform import` するか、ダッシュボードで既存ルールを移す |
| VM の設定（.env）を変えたい | Terraform では VM の作り直しを防ぐため user_data の変更を無視する。VM 上の `/opt/freetier-reader/.env` を編集し `docker compose up -d` |
| VM に入りたい | 既定では受信全閉。OCI の Bastion サービス（無料）か、一時的に `ssh_allowed_cidr` を設定して `apply` |

## 秘密情報の扱い

- `terraform.tfvars` と state（`terraform.tfstate`）には秘密値が入ります。どちらも gitignore 済みです。**絶対にコミットしないでください。**
- state を安全に共有・退避したい場合は `backend.tf.example` を参照（OCI Object Storage の S3 互換 API）。
- cloud-init（user_data）に `.env` を渡すため、OCI のインスタンスメタデータにも秘密値が入ります。テナンシの管理者以外に OCI コンソールの権限を与えないでください。
