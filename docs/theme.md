# 画面テーマ（デジタル庁デザインシステム準拠）

[デジタル庁デザインシステム](https://design.digital.go.jp/dads/)（DADS）を参考にした Miniflux 用テーマを同梱しています。

> 本テーマはデジタル庁の公式なものではありません。色・タイポグラフィ等の値は
> [@digital-go-jp/design-tokens](https://github.com/digital-go-jp/design-tokens) v2.0.1（MIT License, © 2023 デジタル庁）を使用しています（[LICENSE-design-tokens](../themes/dads/LICENSE-design-tokens)）。

## 特徴

| 項目 | 内容 |
|---|---|
| 色 | 本文 Solid Gray 800、リンク Blue 1000（訪問済み Magenta 900）、主要ボタン Blue 900、エラー Red 900、成功 Green 800 |
| 文字 | Noto Sans JP（なければヒラギノ角ゴ / 游ゴシック等）、本文 16px・行間 1.7、記事本文は 1 行 44 文字程度に制限 |
| フォーカス | キーボード操作時に黒の枠 + 黄色（Yellow 300）のリング（ダークモードでは黄色の枠 + 黒のリング） |
| 操作部品 | ボタン・入力欄は角丸 8px、高さ 44px 以上（タップしやすい大きさ） |
| ダークモード | 端末の設定に追従（DADS に公式のダークテーマはないため、同じトークンを反転して構成） |
| アクセシビリティ | 主要な文字と背景の組み合わせ（ライト/ダーク計 68 組）が WCAG 2.2 AA のコントラスト比を満たすことを CI で検証（`themes/dads/test/contrast.test.js`）。動きを減らす設定を尊重 |

## 適用

Terraform で構築した場合は初回構築時に自動で適用されます（`miniflux_theme = "dads"`、既定）。手動で適用・変更する場合:

```bash
cd /opt/freetier-reader
./scripts/apply-theme.sh            # .env の MINIFLUX_THEME（dads / none）を適用
./scripts/apply-theme.sh --reset    # Miniflux 標準に戻す
```

`scripts/update.sh` は更新後に自動で再適用します。

| 設定（.env） | 内容 |
|---|---|
| `MINIFLUX_THEME` | `dads`（既定）/ `none` |
| `MINIFLUX_THEME_WEB_FONT` | `true` で Noto Sans JP を Google Fonts から読み込む（既定 `false`。閲覧端末から Google へ通信が発生するため。Miniflux の CSP にフォントのホストを追加して許可します） |
| `MINIFLUX_API_KEY` | テーマ適用に使う API キー。空なら `ADMIN_USERNAME` / `ADMIN_PASSWORD` を使う。**管理者パスワードを画面から変更した後は必須**（設定 → API キー で発行） |

テーマは Miniflux のユーザー設定（カスタム CSS・テーマ「System - Sans Serif」）として保存されます。Miniflux の設定画面で直接編集した場合、次回の `apply-theme.sh` 実行（更新時を含む）で上書きされます。独自に調整したい場合は `MINIFLUX_THEME=none` にして設定画面で管理してください。

## カスタマイズ

`themes/dads/miniflux.css` は Miniflux のテーマ変数（`--body-color` など）を上書きする構成です。色を変えたら必ずテストを実行してください。

```bash
node --test "themes/**/*.test.js"
```

ネイティブアプリ（Android / iPhone / iPad）は各アプリ自身の表示になるため、このテーマは適用されません（ブラウザ・PWA のみ）。
