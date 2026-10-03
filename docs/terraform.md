# Terraform による構築（OCI + Cloudflare）

`infra/terraform` を 1 回 `apply` すると、次がすべて作られます。

| 対象 | 作成されるもの |
|---|---|
| OCI | VCN / サブネット / インターネットゲートウェイ / セキュリティリスト（インターネットからの受信は全閉。SSH は VCN 内の Bastion からのみ） |
| OCI | Ampere A1 VM（Ubuntu 24.04）。cloud-init で Docker 導入 → clone → `docker compose up --wait`。失敗は通知 |
| OCI | データ用ブロックボリューム（Docker のデータとローカルバックアップ。VM を作り直しても残る） |
| OCI | OCI Bastion（障害時の SSH 経路、無料） |
| OCI | バックアップ用 Object Storage バケット（`backup_retention_days` で自動削除）と VM 用の最小権限 |
| OCI | 月次予算と、実績が発生したら通知するアラート |
| Cloudflare | Tunnel・DNS（CNAME）・Access（One-time PIN、UI は許可メールのみ、同期 API と Webhook はバイパス）・WAF（レート制限、国別制限） |
| 共通 | 管理者パスワード・DB パスワード・Webhook トークンの自動生成 |

## 1. 事前準備

### OCI
1. OCI アカウントを作成し、**Pay As You Go にアップグレード**（Always Free の範囲は無料のまま。アイドル回収と A1 在庫切れの対策）
2. API キーを作成し `~/.oci/config` を設定（OCI コンソール → プロファイル → API キー → 「構成ファイルのプレビュー」）
3. テナンシ OCID を控える
4. SSH 鍵を用意（`ssh-keygen -t ed25519`）。**必須**です（障害時の復旧に使います）

### Cloudflare
1. ドメインを Cloudflare に追加（Free プランで可）
2. Zero Trust を有効化（Free プラン、50 ユーザーまで無料）。チーム名を決める
3. API トークンを作成（「カスタムトークン」）。必要な権限:
   - Account: `Cloudflare Tunnel: Edit`、`Access: Apps and Policies: Edit`、`Access: Organizations, Identity Providers, and Groups: Edit`
   - Zone: `DNS: Edit`、`Zone WAF: Edit`
4. アカウント ID とゾーン ID を控える（ダッシュボードのドメイン概要ページ右下）
5. Zero Trust → Settings → Authentication に既に「One-time PIN」がある場合は、`create_otp_login_method = false` にして、Web UI で使うログイン方式の ID を `existing_access_idp_ids` に指定（未指定だとエラーになります。指定しないとアカウントの全ログイン方式が使えてしまうため）

### 監視（任意・推奨）
[Healthchecks.io](https://healthchecks.io/) でチェックを 2 つ作り、ping URL を `healthcheck_ping_url` / `backup_ping_url` に設定（[operations.md](operations.md#監視)）。

### ツール
- Terraform 1.9 以上

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

完了後、VM の起動と構築スクリプトの完了まで 10 分ほどかかります（`healthcheck_ping_url` を設定していれば成功/失敗が通知されます）。

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
5. [operations.md の確認チェックリスト](operations.md#初回構築後の確認チェックリストe2e) を実施

## VM に SSH で入る（OCI Bastion）

インターネットからの SSH は受け付けません。OCI Bastion のポートフォワーディングセッションを使います。

```bash
cd infra/terraform
oci bastion session create-port-forwarding \
  --bastion-id "$(terraform output -raw bastion_id)" \
  --target-private-ip "$(terraform output -raw instance_private_ip)" \
  --target-port 22 \
  --ssh-public-key-file ~/.ssh/id_ed25519.pub \
  --session-ttl 3600
# 表示された session の ID で接続コマンドを取得（OCI コンソールの Bastion → セッション → 「SSH コマンドのコピー」でも可）
# ssh -i ~/.ssh/id_ed25519 -N -L 2222:<private-ip>:22 -p 22 <session-ocid>@host.bastion.<region>.oci.oraclecloud.com
ssh -i ~/.ssh/id_ed25519 -p 2222 ubuntu@localhost
```

## 設定を変更する

VM の作り直しによるデータ消失を防ぐため、Terraform は VM の `metadata`（cloud-init・SSH 鍵）の変更を無視します。
Terraform 側の変数（許可アカウント・監視 URL など）を変えたら、`apply` 後に VM の `.env` を再同期してください。

```bash
terraform apply
terraform output -raw env_file > /tmp/freetier-reader.env
scp -P 2222 /tmp/freetier-reader.env ubuntu@localhost:/tmp/   # Bastion 経由（上記）
rm /tmp/freetier-reader.env
# VM 上で
sudo install -m 600 /tmp/freetier-reader.env /opt/freetier-reader/.env && rm /tmp/freetier-reader.env
cd /opt/freetier-reader && sudo docker compose up -d --wait
```

`auto_update` や cron の設定（cloud-init の内容）を変えた場合は、VM 上の `/etc/cron.d/freetier-reader` を直接編集するか、VM を作り直します（データボリュームは残ります）。
**PostgreSQL のパスワードは `.env` だけ変えても DB に反映されません**（[operations.md](operations.md#秘密値設定を変更する)）。

## VM を作り直す

```bash
terraform plan -replace=module.oci.oci_core_instance.this
# 確認: oci_core_volume.data は「変更なし」、oci_core_volume_attachment.data は作り直し、oci_identity_dynamic_group は更新
terraform apply -replace=module.oci.oci_core_instance.this
```

データボリュームはそのまま新しい VM に付け替えられ、構築スクリプトはラベル `ftr-data` の既存ファイルシステムをそのままマウントします（Docker のボリュームが残るため、記事・設定はそのまま）。
新しいデータボリュームの初期化は「ラベルがなく、容量が `data_volume_gb` と一致する未使用ディスクがちょうど 1 台」のときだけ行い、曖昧な場合は失敗して通知します。

## すべて削除する

データボリュームには `prevent_destroy` を設定しています。完全に削除する場合は `modules/oci/main.tf` の `prevent_destroy = true` を外してから `terraform destroy` を実行してください。

## よくある問題

| 症状 | 対処 |
|---|---|
| `Out of host capacity`（A1 の在庫切れ） | 時間をおいて再実行 / `availability_domain_index` を変える / PAYG にアップグレード |
| `cloudflare_ruleset` が既存ルールと衝突 | そのゾーンに既に同じフェーズのルールセットがある。`terraform import` するか、ダッシュボードで既存ルールを移す |
| One-time PIN の作成でエラー | 既にアカウントに存在する。`create_otp_login_method = false` |
| 構築が終わらない / 通知が「失敗」 | Bastion 経由で SSH し `/var/log/freetier-reader-bootstrap.log` を確認。修正後 `sudo /usr/local/sbin/freetier-reader-bootstrap.sh` で再実行できる（失敗中は `/var/lib/freetier-reader/bootstrap.failed` があり、`monitor.sh` が通知し続ける） |
| 再起動後に Docker が起動しない | データボリュームがマウントできていない（Docker はマウント完了まで起動しない設定）。`lsblk -f` と `systemctl status docker` を確認 |

## 秘密情報の扱い

- `terraform.tfvars` と state（`terraform.tfstate`）には秘密値が入ります。どちらも gitignore 済みです。**絶対にコミットしないでください。**
- state は手元の PC だけに置くと、PC の故障で失ったときに既存のリソースを Terraform で管理できなくなります。下の「state の退避」で OCI Object Storage に置くことを推奨します。
- cloud-init（user_data）に `.env` を渡すため、OCI のインスタンスメタデータにも秘密値が入ります。テナンシの管理者以外に OCI コンソールの権限を与えないでください。

### state の退避（OCI Object Storage）

コマンドは bash の例です。Windows では `~/.aws/` は `%USERPROFILE%\.aws\`（例: `C:\Users\<you>\.aws\`）にあたります。

1. state 専用のバケットを作る（例: `freetier-reader-tfstate`）。**公開なし・バージョン管理を有効**にする（上書き・通常の削除なら過去の版に戻せる）。保存データは OCI 側で暗号化される
2. OCI コンソール → プロフィール → 「顧客秘密キー」（Customer Secret Key）を作成し、表示されたアクセスキーと秘密キーを `~/.aws/credentials` にプロファイルとして保存する
   ```ini
   [oci-tfstate]
   aws_access_key_id = <アクセスキー>
   aws_secret_access_key = <秘密キー>
   ```
   あわせて `~/.aws/config` に次を追加する（`<region>` はバケットのリージョン）。2026-10 時点で、これがないと state のアップロードが `NotImplemented: AWS chunked encoding not supported` で失敗した（Terraform 1.16.4、ap-osaka-1）
   ```ini
   [profile oci-tfstate]
   region = <region>
   request_checksum_calculation = when_required
   response_checksum_validation = when_required
   ```
   - 顧客秘密キーは作成したユーザーの権限で動くため、state のバケット以外にもアクセスできる。2 つのファイルは自分だけが読めるようにし（Linux / macOS は `chmod 600`）、クラウド同期の対象から外す。漏れた疑いがあればコンソールでキーを削除して作り直す（期限切れはない）
3. `backend.tf.example` を `backend.tf` にコピーし、`<namespace>` と `<region>` を置き換える。`<region>` は `~/.aws/config` の `region`、`backend.tf` の `region`、`endpoints` のホスト名の 3 か所すべてをバケットのリージョンにそろえる（一部だけ違うと `SignatureDoesNotMatch` になる）。namespace はコンソールのテナンシ詳細（「オブジェクト・ストレージ・ネームスペース」）か、OCI CLI の `oci os ns get` で確認する
4. 移行前の state をリポジトリの外にコピーしておき、`terraform init -migrate-state` で手元の state をバケットへ移す。作成直後の顧客秘密キーは使えるまで 10 分ほどかかることがあり、その間は成功と `SignatureDoesNotMatch` が混ざる（少し待って再実行）
5. 移行できたことを確かめる
   - `terraform plan` が `No changes` になる
   - `terraform state list` のリソースが、移行前のコピーと同じ
   - OCI コンソールのバケットに `terraform.tfstate` があり、バケットのバージョン管理が「有効」になっている
6. 確かめられたら、リポジトリ内の `terraform.tfstate` と `terraform.tfstate.backup` を削除する（秘密値を含むため）。移行前のコピーは、別の PC で `terraform init` → `plan` が通るのを確認するまで残しておく

state のロック（`use_lockfile`）を有効にしているため、同時に `plan` / `apply` すると後から始めた方が `Error acquiring the state lock` で止まる（Terraform 1.16.4 と OCI で確認）。作業が異常終了してロックが残った場合は、表示された ID で `terraform force-unlock <ID>` を実行する。

state を壊した・消した場合は、OCI コンソールのバケット →「オブジェクト」→「オブジェクト・バージョンの表示」で以前の版をダウンロードし、`terraform state push` で戻す。バージョンを指定した削除やバケットの削除は元に戻せない。
