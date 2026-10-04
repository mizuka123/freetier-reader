# Miniflux が compose 内部のフィード（rss-bridge など）を取得するための中継。
# Miniflux は FETCHER_ALLOW_PRIVATE_NETWORKS なしでも「明示的に設定したプロキシ」への接続だけは許可するため、
# 内部のフィードはこのプロキシ経由で取得し、それ以外（画像の中継・全文取得を含む）では内部ネットワークへの接続を拒否させる。
FROM alpine:3.23@sha256:85fe1e81d6758c208f3e1eed4338a1997e19d4be002d4dd32d3100c9a8c010a0

# tinyproxy 1.11.3 は CVE-2026-31842（Transfer-Encoding の大文字小文字によるリクエストの解釈ずれ）の影響を受け、
# 2026-10 時点で修正版はない。このプロキシは compose の内部ネットワークからしか届かず、本文のない GET を送るのは
# Miniflux だけのため影響は小さいと判断している。修正版が出たら Alpine の更新で取り込む。
RUN apk add --no-cache tinyproxy
COPY tinyproxy.conf allowed-urls /etc/tinyproxy/

USER nobody
EXPOSE 8888

HEALTHCHECK --interval=60s --timeout=5s --retries=3 \
  CMD nc -z 127.0.0.1 8888 || exit 1

CMD ["tinyproxy", "-d", "-c", "/etc/tinyproxy/tinyproxy.conf"]
