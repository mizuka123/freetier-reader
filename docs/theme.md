# 画面テーマ（デジタル庁デザインシステムを参考にした非公式テーマ）

[デジタル庁デザインシステム](https://design.digital.go.jp/dads/)（DADS）のデザイントークンを参考にした、Miniflux 用の**非公式**テーマを同梱しています。

> 本テーマはデジタル庁の公式なものではなく、デジタル庁による確認・保証を受けたものでもありません。色・タイポグラフィ等の値は
> [@digital-go-jp/design-tokens](https://github.com/digital-go-jp/design-tokens) v2.0.1（MIT License, © 2023 デジタル庁）を使用しています（[LICENSE-design-tokens](../themes/dads/LICENSE-design-tokens)）。

## 特徴

| 項目 | 内容 |
|---|---|
| 色 | 本文 Solid Gray 800、リンク Blue 1000（訪問済み Magenta 900）、主要ボタン Blue 900、エラー Red 900、成功 Green 800 |
| 文字 | Noto Sans JP（なければヒラギノ角ゴ / 游ゴシック等）、本文 16px・行間 1.7、記事本文は 1 行 44 文字程度に制限 |
| フォーカス | キーボード操作時に黒の枠 + 黄色（Yellow 300）のリング（ダークモードでは黄色の枠 + 黒のリング） |
| 操作部品 | ボタン・入力欄は角丸 8px、高さ 44px 以上（タップしやすい大きさ） |
| ダークモード | 端末の設定に追従（DADS に公式のダークテーマはないため、同じトークンを反転して独自に構成） |

## アクセシビリティの検証範囲

CI で次を確認しています。**テーマ全体や Miniflux 全体の WCAG 適合を保証するものではありません**。

- `themes/dads/test/contrast.test.js`: テーマが定義する色の組み合わせ（ライト/ダーク計 168 組。本文・パネル・未読行など主な背景上の文字、ボタン、入力欄、警告、入力欄の枠、フォーカス表示）が WCAG 2.2 AA のコントラスト比（文字 4.5:1、UI 部品 3:1）を満たすこと
- `themes/dads/test/browser.e2e.mjs`（実際の Miniflux + Chromium）: ライト/ダークの配色、Tab 移動時のフォーカス表示、幅 360px で横にはみ出さないこと、Miniflux のテーマ変数と本テーマの変数が一致すること（Miniflux の更新で変数名が変わると検出）

記事本文の中の色（配信元の HTML に含まれるもの）や、ネイティブアプリ（Android / iPhone / iPad）の表示は対象外です。

## 適用

Terraform で構築した場合は初回構築時に自動で適用されます（`miniflux_theme = "dads"`、既定）。手動で適用・変更する場合:

```bash
cd /opt/freetier-reader
./scripts/apply-theme.sh            # .env の MINIFLUX_THEME を適用
./scripts/apply-theme.sh --reset    # dads を初めて適用する前の設定（テーマ・カスタム CSS）に戻す
```

`scripts/update.sh` は更新後に自動で再適用します。適用に失敗すると `.state/theme.failed` が作られ、`scripts/monitor.sh` が通知します（構築・更新そのものは止めません）。

| 設定（.env） | 内容 |
|---|---|
| `MINIFLUX_THEME` | `dads`（既定）: 本テーマを適用 / `none`: **何もしない**（Miniflux の設定画面で自分で管理する場合） |
| `MINIFLUX_THEME_WEB_FONT` | `true` で Noto Sans JP を Google Fonts から読み込む（既定 `false`。閲覧端末から Google へ通信が発生するため）。Miniflux の「外部フォントのホスト」に `fonts.googleapis.com fonts.gstatic.com` を設定して CSP で許可します |
| `MINIFLUX_API_KEY` | テーマ適用に使う API キー。空なら `ADMIN_USERNAME` / `ADMIN_PASSWORD` を使う。**管理者パスワードを画面から変更した後は必須**（設定 → API キー で発行） |

- 認証情報は curl の設定ファイル経由で渡すため、プロセス一覧には表示されません。
- `MINIFLUX_THEME=dads` の間は、Miniflux の設定画面でカスタム CSS・テーマを変更しても、次回の `apply-theme.sh`（更新時を含む）で上書きされます。自分で調整したい場合は `MINIFLUX_THEME=none` にしてください。
- Miniflux の API は「外部フォントのホスト」を空にできないため、Web フォントを無効に戻しても設定は残ります（`@import` は外れるので通信は発生しません）。消す場合は Miniflux の設定画面で空にしてください。

## カスタマイズ

`themes/dads/miniflux.css` は Miniflux のテーマ変数（`--body-color` など）を上書きする構成です。色を変えたら必ずテストを実行してください。

```bash
node --test "themes/**/*.test.js"
```
