# 端末での利用（Android / iPhone / iPad / ブラウザ）

方針: **ブラウザ**は Cloudflare Access + Miniflux ログイン（長期セッション）、
**ネイティブアプリ**は同期 API（Access 対象外）で初回設定のみ、にして再ログインを最小化します。

## アプリ候補

Miniflux 公式ドキュメント「Third-Party Applications」掲載アプリから選定しています。対応状況は導入時に実機で確認してください。

| 端末 | 第 1 候補 | 第 2 候補 | その他 |
|---|---|---|---|
| Android | Capy Reader（無料・OSS） | Read You（無料・OSS） | FeedMe、FocusReader、FluxNews |
| iPhone / iPad | NetNewsWire（無料・OSS） | Lire（有料、Miniflux API / Fever） | Unread、Reeder Classic、ReadKit |
| 全端末で同じ UI | FluxNews（iOS / Android、Miniflux API） | ― | ― |
| PC ブラウザ | Miniflux 標準 UI（PWA としてインストール可） | ReactFlux | ― |

## Miniflux 側の準備

1. 設定 → 連携
   - **Google Reader API** を有効化し、ユーザー名とパスワード（Web ログインとは別の値）を設定
   - **Fever API** を有効化し、ユーザー名とパスワードを設定
2. 設定 → API キー → 端末ごとにキーを作成（Miniflux API 対応アプリ用）。端末を紛失したらそのキーだけ削除する

## アプリでの接続設定

| API | サーバ URL | 認証 |
|---|---|---|
| Miniflux API | `https://reader.example.com` | API キー |
| Google Reader API | `https://reader.example.com`（アプリによっては `/reader/api/0`） | 連携画面で設定したユーザー名 / パスワード |
| Fever API | `https://reader.example.com/fever/` | 連携画面で設定したユーザー名 / パスワード |

これらのパスは Cloudflare Access の対象外ですが、Cloudflare WAF でレート制限（既定: 同一 IP から 10 秒あたり 150 リクエスト）と国別制限（既定: 日本のみ）がかかっています。

- 海外で使うときは `api_allowed_countries` を一時的に変更してください。
- 購読数が多い状態でアプリの初回同期がブロックされる（HTTP 429 / Cloudflare のブロック画面）場合は、`api_rate_limit_per_10s` を引き上げてください。Cloudflare のダッシュボード（Security → Events）でブロックされたリクエスト数を確認できます。

## ブラウザ（PC・iPad・スマホ）

1. `https://reader.example.com` を開く → Cloudflare Access（メールのワンタイムコード、1 か月有効）
2. Miniflux にログイン → 設定 → **パスキーを登録**（次回から指紋 / 顔認証のみ）
3. PWA としてインストールするとアプリのように使えます
   - iPhone / iPad: Safari の共有 → ホーム画面に追加
   - Android / PC: Chrome のメニュー → アプリをインストール
