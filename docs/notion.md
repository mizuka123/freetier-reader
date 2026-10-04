# スターを付けた記事を Notion に保存する（star-to-notion）

Miniflux でスターを付けた記事を、本文ごと Notion のデータベースに保存します。一覧で見出しだけ見て、気になった記事にスターを付けておけば、あとで Notion で読んだり整理したりできます。

- スターはどの端末（Web 画面・Capy Reader・iPad のアプリなど）で付けても同期されるので、保存の合図に使えます
- 5 分ごと（`STAR_POLL_MINUTES`）に Miniflux を確認し、新しくスターが付いた記事を 1 件ずつ Notion に送ります
- **スターを外しても Notion からは消しません**。もう一度スターを付けても、二重には保存しません
- 本文は見出し・段落・箇条書き・引用・コード・画像・リンク・太字などを Notion のブロックに変換します
- 要約だけの記事（本文が短く、フィードの「全文を取得」がオフ）は、元記事のページから全文の取得を試します（Miniflux の記録は書き換えません）
- 画像は元のサイトの URL を Notion に渡して表示します（Miniflux の画像プロキシの URL は元の URL に戻します）

## 仕組みと制約

```
star-to-notion ──API キー──> miniflux（スター付きの記事の ID・本文）
       └──────トークン──> api.notion.com（データベースにページを作成）
```

- 受け付けるポートはありません。外部から呼ばれることはなく、Miniflux と Notion にこちらから接続するだけです
- 送信の記録（どの記事を送ったか）は SQLite（ボリューム `notion-data`）に保存し、毎日のバックアップに含まれます

次の点に注意してください。

| 制約 | 内容 |
|---|---|
| すぐ外したスター | 確認の間隔（5 分）より前にスターを外した記事は保存されません |
| 導入前のスター | 有効にした時点ですでにスターが付いている記事は送りません。必要なら `backfill` で送ります（下記） |
| Notion の無料プラン | **メンバーが 2 人以上いる無料のワークスペースは、作れるブロックが累計 1,000 個まで**です（削除しても戻りません）。自分 1 人のワークスペースか有料プランで使ってください。上限に達すると監視が異常を知らせます |
| 長い記事 | 1 記事あたり `STAR_MAX_BLOCKS`（既定 1,000）ブロックまで。超えた分は省略し、「続きは元記事へ」と書きます |
| 表 | 行ごとの文字（セルを ` \| ` で区切る）にします |
| 動画・埋め込み | YouTube などはリンク（ブックマーク）にします |
| 画像 | 元のサイトの画像を参照するため、元のサイトで消えると表示されなくなります。`http://` の画像は Notion が表示できないため、リンクにします |
| 変換できない本文 | Notion が受け付けなかった場合は、文字だけの形（状態「簡易保存」）、それも駄目なら本文なし（状態「本文なし」。元記事へのリンクのみ）で保存します |

費用はかかりません（既存の VM の中で動き、Notion の API は無料プランで使えます。画像はアップロードしません）。

## 準備

### 1. Notion のコネクション（インテグレーション）を作る

1. Notion の「設定」→「コネクション」→「インテグレーションを開発または管理する」を開く（開発者ポータル）
2. 新しい**内部（Internal）**のコネクションを作る。ワークスペースは保存先のものを選ぶ
3. 機能（Capabilities）は「コンテンツを読み取る」「コンテンツを更新」「コンテンツを挿入」を有効にする（ユーザー情報は不要）
4. 表示されたトークン（`ntn_` で始まる）を控える。**秘密値です。チャットやスクリーンショットに写さないでください**

### 2. 保存先のデータベースを作り、コネクションを追加する

1. Notion で新しいページを作り、フルページの「データベース」を作る（列はあとで自動で追加できます）
2. データベースのページの右上「•••」→「コネクション」→ 1 で作ったコネクションを追加
3. データベースの URL を控える（「リンクをコピー」。`NOTION_DATABASE_ID` に URL のまま設定できます）

### 3. Miniflux の API キーを作る

Miniflux の「設定」→「API キー」→「新しい API キーを作成」で、説明に `star-to-notion` などと入れて作成し、表示されたキーを控えます。
このサービス専用のキーにしておくと、漏れたときにこのキーだけ削除して作り直せます（Miniflux の API キーには読み取り専用の種類がありません）。

### 4. VM で有効にする

秘密値はエディタで `.env` に直接書きます（コマンドラインに書くと履歴に残るため）。

```bash
cd /opt/freetier-reader
sudo git pull
sudo nano .env
#   NOTION_TOKEN=<1 のトークン>
#   NOTION_DATABASE_ID=<2 の URL または ID>
#   STAR_MINIFLUX_API_KEY=<3 の API キー>
#   COMPOSE_PROFILES の末尾に ,notion を追加（例: cloudflare,x → cloudflare,x,notion）

sudo docker compose up -d --build star-to-notion
# データベースに必要な列（プロパティ）を追加する（最初の 1 回だけ）
sudo docker compose exec star-to-notion node src/cli.js setup-notion
# 状態を確認する
sudo docker compose exec star-to-notion node src/cli.js status
sudo docker compose logs --tail 50 star-to-notion
```

初回の確認で、その時点のスター付きの記事は「導入前（baseline）」として記録され、送られません。以降に付けたスターから保存されます。
Miniflux で記事にスターを付け、5 分ほど待って Notion のデータベースにページができることを確認してください。

導入前のスター付きの記事も送る場合（新しいものから）:

```bash
sudo docker compose exec star-to-notion node src/cli.js backfill 20     # 20 件
sudo docker compose exec star-to-notion node src/cli.js backfill --all  # 全部
```

1 記事あたり数回〜数十回 Notion の API を呼ぶため、件数が多いと保存まで時間がかかります（API の上限に合わせて間隔をあけて送ります）。

## Notion のデータベースの列

`setup-notion` が次の列を追加します（最初からある「名前」の列は「タイトル」に名前を変えます）。列の名前を変えると保存できなくなります。列を追加したり、ビューを作ったりするのは自由です。

| 列 | 型 | 内容 |
|---|---|---|
| タイトル | タイトル | 記事のタイトル |
| URL | URL | 元記事の URL |
| フィード | セレクト | フィードの名前 |
| 公開日 | 日付 | 記事の公開日時 |
| 保存日 | 日付 | Notion に保存した日時 |
| Miniflux ID | 数値 | Miniflux の記事の ID（二重保存の防止に使う） |
| 状態 | セレクト | `保存済み` / `簡易保存`（文字だけ） / `本文なし`（リンクのみ） / `保存中`（送信の途中） |
| 同期 ID | テキスト | 送信ごとの ID（途中で止まった送信の後始末に使う） |

`保存中` のページは送信の途中で止まったものです。次の確認で、このサービスが自動で片付けて送り直します。

## 管理コマンド

`sudo docker compose exec star-to-notion node src/cli.js <コマンド>` で実行します。

| コマンド | 内容 |
|---|---|
| `status` | 状態の要約と、送信待ち・確認が必要な記事の一覧 |
| `setup-notion` | データベースに足りない列を追加する |
| `backfill <件数>` / `backfill --all` | 導入前からスターが付いていた記事を送信待ちにする（新しいものから） |
| `retry <記事 ID>` | 失敗した記事などを送信待ちに戻す |
| `ack <記事 ID>` / `ack --all` | 確認が必要な記事を「確認済み」にし、監視の異常から外す |

記事の状態:

| 状態 | 意味 | 対応 |
|---|---|---|
| `failed` | 8 回失敗した | `status` で理由を確認し、`retry` か `ack` |
| `missing` | Miniflux から記事が消えていた（フィードを削除したなど） | `ack` |
| `review` | Notion に同じ記事の作りかけのページがあり、このサービスの記録と一致しない | Notion でそのページを削除してから `retry` |

## 監視

`scripts/monitor.sh`（10 分ごと）が `/status` を確認し、次の場合に異常を通知します。

- 確認の間隔の 3 倍（最低 30 分）を超えて Miniflux を確認できていない（API キーの誤り・削除など）
- Notion への保存が止まっている（トークンの誤り、データベースの共有の解除・削除、列の不足、無料プランのブロック上限）
- スターを付けてから 24 時間以上保存できていない記事がある
- `failed` / `missing` / `review` の記事がある

## 設定を変える・止める

| 変更したいもの | 手順 |
|---|---|
| Notion のトークン | 開発者ポータルでトークンを再発行 → `.env` の `NOTION_TOKEN` を変更 → `sudo docker compose up -d star-to-notion` |
| Miniflux の API キー | Miniflux で新しいキーを作成 → `.env` の `STAR_MINIFLUX_API_KEY` を変更 → `sudo docker compose up -d star-to-notion` → 古いキーを削除 |
| 保存先のデータベース | `.env` の `NOTION_DATABASE_ID` を変更 → コネクションを追加 → `sudo docker compose up -d star-to-notion` → `setup-notion` |
| 確認の間隔・全文取得 | `.env` の `STAR_POLL_MINUTES` / `STAR_FETCH_FULL_CONTENT` / `STAR_MIN_CONTENT_CHARS` を変更 → `sudo docker compose up -d star-to-notion` |
| 止める | `.env` の `COMPOSE_PROFILES` から `notion` を外し、`sudo docker compose up -d --remove-orphans`。Notion のコネクションと Miniflux の API キーも削除する |

## バックアップとリストア

送信の記録（`star-to-notion.db`）は毎日のバックアップに含まれます（[operations.md](operations.md#バックアップとリストア)）。
この機能を有効にする前に作ったバックアップから戻す場合は `restore.sh --skip-notion` を使います（送信の記録は今のまま残ります）。

バックアップから戻して送信の記録が古くなっても、二重には保存しません。送る前に Notion を Miniflux ID で調べ、保存済みのページがあれば送ったものとして扱います。
