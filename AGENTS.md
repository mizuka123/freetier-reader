# AGENTS.md

このリポジトリで開発する人と AI コーディングエージェント向けのガイドです。利用者向けの説明は [README.md](README.md) と [docs/](docs/) を参照してください。

## 構成

| パス | 内容 |
|---|---|
| `compose.yml` | 全コンテナの定義。オプション機能は Compose のプロファイル（`cloudflare` / `x` / `morss` / `rsshub`） |
| `services/x-webhook-rss/` | IFTTT Webhook → Atom の自作サービス（Node.js 24、ESM、外部依存なし。DB は `node:sqlite`） |
| `themes/dads/` | Miniflux 用 CSS テーマとそのテスト |
| `scripts/` | 初期化・バックアップ・リストア・更新・監視・テーマ適用（bash）。共通処理は `scripts/lib.sh` |
| `infra/terraform/` | OCI + Cloudflare の構築。VM の初期設定は `templates/cloud-init.yaml.tftpl` |
| `config/` | RSS-Bridge などの設定 |
| `docs/` | 利用者向けドキュメント（日本語） |

## 検証コマンド

変更した範囲に応じて、CI（`.github/workflows/ci.yml`）と同じ確認を手元で行います。

```bash
# x-webhook-rss
(cd services/x-webhook-rss && npm test)

# テーマのコントラスト比
node --test "themes/**/*.test.js"

# シェルスクリプト
shellcheck -S warning -x scripts/*.sh

# Compose
cp -n .env.example .env
docker compose --profile cloudflare --profile x --profile morss --profile rsshub config --quiet

# Terraform
(cd infra/terraform && terraform fmt -check -recursive && terraform init -backend=false && terraform validate && tflint --recursive)
```

テーマの適用（`apply-theme.sh`）とブラウザ確認は、実際の Miniflux を起動する CI ジョブ `theme-e2e` で検証しています。手元で再現する場合は同ジョブの手順に従ってください。

## 守ること

- **秘密情報・個人設定をコミットしない。** `.env`、`*.tfvars`、tfstate、OPML、`*.local.*` は gitignore 済み。値の例は `.env.example` / `terraform.tfvars.example` に `CHANGE_ME` などのダミーで書く。CI では gitleaks が走る。
- **`.env` を shell として `source` しない。** スクリプトでは `scripts/lib.sh` の `load_env` を使う（値に記号が含まれても安全なため）。
- **データを失う可能性がある操作は、失敗時に元へ戻せるようにする。** backup / restore / update は `ops_lock` で排他し、失敗時のロールバックを持たせている。同じ方針を崩さない。
- **PostgreSQL のメジャー更新はイメージのタグを変えるだけでは済まない。** データ移行が必要（[docs/operations.md](docs/operations.md)）。Dependabot の PR もそのままマージしない。
- **Node.js のメジャー更新は LTS になってから**、`Dockerfile` と CI の `node-version` を揃えて行う。
- **x-webhook-rss に npm の依存を追加しない**（Node 標準モジュールだけで書く）。
- **テーマの色を変えたら**、コントラストのテスト（WCAG 2.2 AA）を通す。デザイントークンの出典表記（`themes/dads/LICENSE-design-tokens`）を消さない。
- **スクレイピング対象サイトの規約を尊重する。** X は IFTTT の公式連携のみを扱い、Cookie の流用など規約に反する方法は入れない。
- 利用者に影響する変更（手順・環境変数・既定値）は、`docs/` と `.env.example` も同じ PR で更新する。

## スタイル

- コード中のコメントとドキュメントは日本語。ログやエラーメッセージ、識別子は英語。
- bash は `#!/usr/bin/env bash` と `set -euo pipefail`、shellcheck の警告ゼロ。
- JavaScript は ESM、型は JSDoc で書く。テストは `node:test`。

## Git / PR

- `main` へ直接コミットしない。ブランチを切って PR を出す。
- コミットメッセージは Conventional Commits（`feat:` / `fix(theme):` / `chore(deps):` / `docs:` / `test:` など）、英語で書く。
- PR は CI がすべて通ってからマージする。`image` ジョブは main への push 時だけ動くので、マージ後に結果を確認する。

## ローカル専用のメモ

自分の環境に固有の情報（テナンシー、ホスト名、検証用 VM、タスク管理ツールの URL など）は、このファイルではなく `AGENTS.local.md` や `CLAUDE.local.md` に書く（gitignore 済み）。
