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

先に VM でコンテナを起動し、動くことを確かめてから Cloudflare 側で公開します（逆の順にすると、公開した URL が起動までの間 502 になります）。

1. VM の `.env` の `COMPOSE_PROFILES` に `web` を追加し、コンテナを起動

   ```bash
   cd /opt/freetier-reader
   sudo git pull
   # COMPOSE_PROFILES に web がなければ末尾に追加する（例: cloudflare,x → cloudflare,x,web）
   grep -Eq '^COMPOSE_PROFILES=([^#]*,)?web(,|$)' .env || sudo sed -i -E 's/^(COMPOSE_PROFILES=[A-Za-z0-9,_-]*)/\1,web/' .env
   grep '^COMPOSE_PROFILES=' .env
   sudo docker compose up -d --wait reactflux   # healthy になるまで待つ
   ```

   `.env` を手で編集しても構いません。`terraform output -raw env_file` で `.env` 全体を再同期する方法もあります（[terraform.md](terraform.md)）。

2. `terraform.tfvars` に追加して `terraform apply`（Access アプリ・DNS レコード・Tunnel の経路が作られます）

   ```hcl
   web_hostname     = "web.example.com"
   compose_profiles = ["cloudflare", "x", "web"]
   ```

3. 別のブラウザ（シークレットウィンドウなど）で `https://web.example.com` を開き、Cloudflare Access のログイン画面になることを確認します。

手動構築の場合は、`.env` の `COMPOSE_PROFILES` に `web` を追加し、Cloudflare Tunnel の Public Hostname に `web.example.com` → `http://reactflux:2000` を追加して、Access のアプリケーションで保護してください。

## ログイン

1. `https://web.example.com` を開く → Cloudflare Access（メールのワンタイムコード）
2. Miniflux の画面（設定 → API キー）で ReactFlux 用の API キーを作る
3. ReactFlux のログイン画面で、サーバに `https://reader.example.com`、認証方式に **API キー** を選んで入力

- **ユーザー名・パスワードではログインしないでください。** ReactFlux はパスワードでのログインもできますが、ブラウザに保存されるため、漏れたときの影響が大きくなります。API キーならキーごとに取り消せます。誤ってパスワードを入力した場合は、Miniflux の設定画面でパスワードを変更してください。
- API キーはこのブラウザ（web.example.com）に保存され、Miniflux の API をそのユーザーの権限（管理者なら管理者の権限）で使えます。共用の PC では使わないでください。
- API キーは ReactFlux 専用に作り、名前で区別しておきます。使わなくなったとき、端末をなくしたとき、漏れた疑いがあるときは、Miniflux の設定 → API キーで削除します（ReactFlux は次の通信からログアウトされます）。

## うまく表示されないとき

ReactFlux の画面は開くのに記事が読み込めない場合は、ブラウザの開発者ツール（Network タブ）で `/v1/` へのリクエストの結果を確認します。

| 結果 | 主な原因 |
|---|---|
| 401 | API キーの誤り・削除済み。Miniflux で作り直してログインし直す |
| 403（Cloudflare のブロック画面） | 国別制限。日本以外の回線（VPN・海外）から使っている（[apps.md](apps.md)） |
| 429 | レート制限（`api_rate_limit_per_10s`）。Cloudflare のダッシュボード（Security → Events）で確認 |
| 502 / 応答なし | VM 側の `reactflux` コンテナ（`sudo docker compose ps reactflux`）または Miniflux が止まっている |

## 更新

イメージは `compose.yml` で tag@digest に固定しており、Dependabot が更新 PR を出します。CI は amd64 / arm64 の両方でこのイメージを起動し、画面のファイルが配信されることを確認します（Miniflux の API との組み合わせまでは確認しません）。ReactFlux は対応する Miniflux のバージョン（現在 2.3.2 以上）を README に記載しているので、Miniflux を更新するときはあわせて確認してください。

## 無効にする

`web_hostname = ""` にして `terraform apply` し（先に公開を止める）、VM の `.env` の `COMPOSE_PROFILES` から `web` を外して `sudo docker compose up -d --remove-orphans` を実行します。ReactFlux 用に作った API キーは Miniflux の設定画面で削除してください。
