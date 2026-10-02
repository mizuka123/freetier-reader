# RSS のないサイトをフィード化する

RSS-Bridge の **CssSelectorBridge** で、トップページなどから記事リンクを集め、各記事の本文を CSS セレクタで抜き出します。
JavaScript で描画するサイトは対象外です（必要になったら Browserless 等の追加を検討）。

## 例: スポーツ報知（https://hochi.news/）

調査結果（2026-10）:

- 公式 RSS はなし（`/rss`、`/rss.xml`、`/feed` いずれも存在せず、HTML 内にも RSS リンクなし）
- トップページに記事リンク `/articles/YYYYMMDD-OHT1T*.html` が静的 HTML で含まれる
- 記事本文は `p.preview__text`（静的 HTML）
- 有料記事（報知プレミアム）は冒頭のみ取得されます

Miniflux に次の URL を購読として追加します（Docker 内部ネットワーク経由）:

```
http://rss-bridge/?action=display&bridge=CssSelectorBridge&home_page=https%3A%2F%2Fhochi.news%2F&url_selector=a%5Bhref%5E%3D%22%2Farticles%2F%22%5D&url_pattern=&content_selector=p.preview__text&content_cleanup=&title_cleanup=+-+%E3%82%B9%E3%83%9D%E3%83%BC%E3%83%84%E5%A0%B1%E7%9F%A5&limit=30&format=Atom
```

| パラメータ | 値 | 意味 |
|---|---|---|
| `home_page` | `https://hochi.news/` | 記事リンクを集めるページ |
| `url_selector` | `a[href^="/articles/"]` | 記事リンクの CSS セレクタ |
| `content_selector` | `p.preview__text` | 本文の CSS セレクタ |
| `title_cleanup` | ` - スポーツ報知` | タイトル末尾から除去する文字列 |
| `limit` | `30` | 取得件数 |

追加前に、VM 上で結果を確認できます:

```bash
docker compose exec miniflux wget -qO- "http://rss-bridge/?action=display&bridge=CssSelectorBridge&...&format=Atom" | head -50
```

### Miniflux 側の補助設定（任意）

本文が途中で切れる場合は、Miniflux のフィード設定で次を設定します。

- 「元のコンテンツを取得」（Fetch original content）: 有効
- スクレイパールール: `p.preview__text`

## 別のサイトを追加するとき

1. ブラウザの開発者ツールで、記事リンクと本文の CSS セレクタを調べる
2. ページのソース表示（JavaScript 実行前の HTML）にそれらが含まれるか確認する（含まれなければ CssSelectorBridge では取れない）
3. 上の URL のパラメータを差し替えて Miniflux に追加
4. 巡回間隔は 30 分以上にし、サイトの利用規約を確認する
