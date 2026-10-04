# PC 向けの Web 画面（ReactFlux）

Miniflux 標準の Web 画面は、カテゴリやフィードを切り替えるたびにページを移動する必要があります。PC では、Miniflux 用の Web 画面 [ReactFlux](https://github.com/electh/ReactFlux)（MIT License、日本語対応）を別のホスト名で使えます。

- サイドメニュー（未読・スター付き・カテゴリ・フィード）+ 記事一覧 + 本文の 3 ペインで、画面遷移なしに切り替えられる
- ダークモード、レイアウト（列・リスト・カード）、文字の大きさなどを画面上で変えられる
- キーボード操作（`j` / `k` など）に対応

ReactFlux は静的ファイルを配信するだけのコンテナです。記事の取得や既読・スターの変更は、ブラウザから Miniflux の API（`https://<reader_hostname>/v1/`）へ直接行います。Miniflux 標準の画面（`https://<reader_hostname>/`）はそのまま使えるので、フィードの追加や設定変更はこれまでどおり Miniflux の画面で行えます。

## 構成

```
[PC ブラウザ] ──https://web.example.com── Cloudflare Access ── Tunnel ── reactflux（静的ファイル）
      └──────https://reader.example.com/v1/（API。Access 対象外・WAF）── Tunnel ── miniflux
```

- Web 画面のホスト名も Cloudflare Access で本人だけに限定します（UI と同じポリシー）。
- API は既存の同期 API と同じ経路です（国別制限・レート制限の対象）。海外から使う場合は `api_allowed_countries` を変更してください（[apps.md](apps.md)）。

## 有効にする（Terraform で構築した場合）

1. `terraform.tfvars` に追加して `terraform apply`（DNS レコード・Tunnel の経路・Access アプリが作られます）

   ```hcl
   web_hostname     = "web.example.com"
   compose_profiles = ["cloudflare", "x", "web"]
   ```

2. VM の `.env` の `COMPOSE_PROFILES` に `web` を追加し、コンテナを起動

   ```bash
   cd /opt/freetier-reader
   sudo git pull
   sudo sed -i 's/^COMPOSE_PROFILES=.*/&,web/' .env   # 例: cloudflare,x → cloudflare,x,web
   sudo docker compose up -d
   ```

   `terraform output -raw env_file` で `.env` 全体を再同期しても構いません（[terraform.md](terraform.md)）。

手動構築の場合は、`.env` の `COMPOSE_PROFILES` に `web` を追加し、Cloudflare Tunnel の Public Hostname に `web.example.com` → `http://reactflux:2000` を追加して、Access のアプリケーションで保護してください。

## ログイン

1. `https://web.example.com` を開く → Cloudflare Access（メールのワンタイムコード）
2. Miniflux の画面（設定 → API キー）で ReactFlux 用の API キーを作る
3. ReactFlux のログイン画面で、サーバに `https://reader.example.com`、認証方式に **API キー** を選んで入力

- API キーはこのブラウザ（web.example.com）に保存されます。共用の PC では使わないでください。使わなくなったら Miniflux の設定画面で API キーを削除します。
- 管理者のパスワードではなく API キーを使ってください（パスワードを変えても影響を受けず、キーごとに取り消せるため）。

## 更新

イメージは `compose.yml` で tag@digest に固定しており、Dependabot が更新 PR を出します。ReactFlux は対応する Miniflux のバージョン（現在 2.3.2 以上）を README に記載しているので、Miniflux を更新するときはあわせて確認してください。

## 無効にする

`web_hostname = ""` にして `terraform apply` し、`.env` の `COMPOSE_PROFILES` から `web` を外して `sudo docker compose up -d --remove-orphans` を実行します。ReactFlux 用に作った API キーは Miniflux の設定画面で削除してください。
