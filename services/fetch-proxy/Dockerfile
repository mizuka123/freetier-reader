# Miniflux が compose 内部のフィード（rss-bridge など）を取得するための中継。
# Miniflux は FETCHER_ALLOW_PRIVATE_NETWORKS なしでも「明示的に設定したプロキシ」への接続だけは許可するため、
# 内部のフィードはこのプロキシ経由で取得し、それ以外（画像の中継・全文取得を含む）では内部ネットワークへの接続を拒否させる。
FROM alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6

# tinyproxy 1.11.3 は CVE-2026-31842（Transfer-Encoding の大文字小文字によるリクエストの解釈ずれ）の影響を受け、
# 2026-10 時点で修正版はない。このプロキシは compose の内部ネットワークからしか届かず、本文のない GET を送るのは
# Miniflux だけのため影響は小さいと判断している。修正版が出たら Alpine の更新で取り込む。
RUN apk add --no-cache tinyproxy
COPY tinyproxy.conf allowed-urls /etc/tinyproxy/

USER nobody
EXPOSE 8888

# 許可していない URL を問い合わせ、tinyproxy 自身が 403（Filtered）を返すことで、HTTP を処理できて拒否の設定も
# 効いていることを確かめる（フィルタは名前解決より前に評価されるため、.invalid の名前解決や外部への通信は発生しない）。
# 接続だけを確かめる nc -z は、何も送らずに切断するため tinyproxy が毎回 ERROR を記録してしまう。
# 応答はいったん全部受け取ってから調べる（grep が途中でやめて接続が先に切れないように）。理由句（Filtered）は
# tinyproxy の版で変わりうるため、ステータスコードだけを見る。
# この方法でも 1 分に 1 回 NOTICE（Proxying refused on filtered url "http://healthcheck.invalid/"）が記録される
HEALTHCHECK --interval=60s --timeout=5s --retries=3 \
  CMD r="$(printf 'GET http://healthcheck.invalid/ HTTP/1.0\r\n\r\n' | nc -w 3 127.0.0.1 8888)" && printf '%s\n' "$r" | grep -q '^HTTP/1\.[01] 403' || exit 1

CMD ["tinyproxy", "-d", "-c", "/etc/tinyproxy/tinyproxy.conf"]
