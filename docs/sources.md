# RSS のないサイトをフィード化する

RSS-Bridge の **CssSelectorBridge** で、トップページなどから記事リンクを集め、各記事の本文を CSS セレクタで抜き出します。
JavaScript で描画するサイトは対象外です（必要になったら Browserless 等の追加を検討）。

どのサイトを対象にするかは利用者が自由に決めます。以下のスポーツ報知は手順の例です。対象サイトごとに同じ手順でセレクタを調べ、購読 URL を作ってください。

## 例: スポーツ報知（https://hochi.news/）

> この例は技術的な動作例です。サイトによる許諾や、今後も同じ方法で取得できることを保証するものではありません。取得した記事は個人で読む範囲にとどめ（公開・再配信しない）、利用前と定期的にサイトの利用規約と robots.txt を確認してください。

調査結果（2026-10 時点。サイトの構造が変わるとセレクタの見直しが必要）:

- 公式 RSS はなし（`/rss`、`/rss.xml`、`/feed` いずれも存在せず、HTML 内にも RSS リンクなし）
- タグのページ（例: `https://hochi.news/tag/プロ野球`）に、記事一覧 `a.article-list__unit` が静的 HTML で 50 件含まれる
- 記事ページの本文は `.preview__wrap` の中にある（見出し・日付・画像の `a.preview__head`、本文の段落の `div.preview__detail`、「続きを読む」）
- 有料記事（報知プレミアム）は冒頭のみ取得されます

Miniflux に次の URL を購読として追加します（Docker 内部ネットワーク経由。`home_page` のタグを変えれば別の分野を購読できます）:

```
http://rss-bridge/?action=display&bridge=CssSelectorBridge&home_page=https%3A%2F%2Fhochi.news%2Ftag%2F%25E3%2583%2597%25E3%2583%25AD%25E9%2587%258E%25E7%2590%2583&url_selector=a.article-list__unit&url_pattern=&content_selector=.preview__wrap&content_cleanup=.preview__media%2C+.preview__image%2C+.readmore__label-wrapper&title_cleanup=+-+%E3%82%B9%E3%83%9D%E3%83%BC%E3%83%84%E5%A0%B1%E7%9F%A5&limit=30&format=Atom
```

**購読するときは「詳細オプション」の「プロキシ経由で取得」（Fetch via proxy）を有効にしてください。** Miniflux は内部ネットワークへの直接の接続を拒否する設定になっており、`rss-bridge` などの内部のフィードは、許可したホストだけを中継する `fetch-proxy` を通して取得します。有効にし忘れた場合も、`scripts/update.sh`（または `scripts/internal-feeds.sh`）が内部のフィードを自動でプロキシ経由に切り替えます。
内部のフィードでは「オリジナルの内容を取得」（全文取得）を有効にしないでください。全文取得も同じプロキシを通るため、外部の記事ページは拒否されて取得できません。本文は `content_selector` で取り出します。

| パラメータ | 値 | 意味 |
|---|---|---|
| `home_page` | `https://hochi.news/tag/プロ野球` | 記事リンクを集めるページ |
| `url_selector` | `a.article-list__unit` | 記事リンクの CSS セレクタ（サイドバーなど一覧の外のリンクを含めない） |
| `content_selector` | `.preview__wrap` | 本文全体を囲む要素の CSS セレクタ |
| `content_cleanup` | `.preview__media, .preview__image, .readmore__label-wrapper` | 本文から除く要素。`.preview__media` は見出しと日付（記事のタイトルと重複）、`.preview__image` は画像、`.readmore__label-wrapper` は「続きを読む」 |
| `title_cleanup` | ` - スポーツ報知` | タイトル末尾から除去する文字列 |
| `limit` | `30` | 取得件数。RSS-Bridge はキャッシュ（このブリッジは 1 時間）が切れるたびに一覧 1 ページと記事ページを最大この件数だけ取得する |

- サイトへのアクセスは Miniflux の巡回間隔ではなく RSS-Bridge のキャッシュで決まります（1 時間に 1 回、最大 1 + `limit` 回）。複数のタグを購読する場合は `limit` を減らしてください。
- `content_selector` は**最初に一致した 1 要素だけ**が使われます。`p.preview__text` のように段落を指定すると 1 段落目しか取れないため、本文全体を囲む要素を指定し、不要な部分を `content_cleanup` で除きます。
- 報知の記事の画像は `<picture>` の `srcset`（幅の指定なし）で書かれており、RSS-Bridge の変換で画像の URL が失われます（記事ページの URL になる）。そのため本文からは画像を除き、RSS-Bridge が記事ページの `og:image` から付ける添付（enclosure）で表示します。この構成の Miniflux と Capy Reader では、添付の画像が記事と一緒に表示されることを確認しています（ほかのアプリでは表示されない場合があります）。

追加前に、VM 上で全件の結果を確認できます（記事数、本文が空の記事、記事ページの URL になった画像、添付画像のない記事を数える）:

```bash
url='http://rss-bridge/?action=display&bridge=CssSelectorBridge&...&format=Atom'
docker compose exec -T miniflux wget -qO- "$url" | python3 -c '
import sys, re, html
x = sys.stdin.read()
es = re.findall(r"<entry>(.*?)</entry>", x, re.S)
body = lambda e: html.unescape((re.search(r"<content[^>]*>(.*?)</content>", e, re.S) or [None, ""])[1])
print("entries:", len(es))
print("empty content:", sum(not re.sub(r"<[^>]+>|\s", "", body(e)) for e in es))
print("images pointing to article pages:", sum(len(re.findall(r"<img[^>]+src=\"[^\"]*/articles/", body(e))) for e in es))
print("entries without image enclosure:", sum("rel=\"enclosure\"" not in e for e in es))
print("could not extract:", x.count("Could not extract"))'
```

記事数が 0、本文が空、または `could not extract` が出る場合は、サイトの構造が変わっています。`url_selector`・`content_selector`・`content_cleanup` を調べ直してください。

### 本文が途中で切れる・画像が壊れる場合

RSS-Bridge のフィードは内部のフィードのため、Miniflux の「元のコンテンツを取得」（全文取得）は使えません（外部の記事ページへの取得がプロキシで拒否されます）。
代わりに、購読 URL の `content_selector` を本文全体を囲む要素に変え、余計な部分を `content_cleanup` で除いて、RSS-Bridge 側で本文を取り出してください。
本文中の画像が記事ページの URL になって表示されない場合は、上の報知の例のように画像の要素を `content_cleanup` で除き、添付（`og:image`）の画像を使います。

## 別のサイトを追加するとき

1. ブラウザの開発者ツールで、記事リンクと本文の CSS セレクタを調べる
2. ページのソース表示（JavaScript 実行前の HTML）にそれらが含まれるか確認する（含まれなければ CssSelectorBridge では取れない）
3. 上の URL のパラメータを差し替えて Miniflux に追加
4. 巡回間隔は 30 分以上にし、サイトの利用規約を確認する
