#!/usr/bin/env bash
# compose 内部のフィード（rss-bridge / x-webhook-rss / morss / rsshub）に「プロキシ経由で取得」を設定する。
# Miniflux は内部ネットワークへの直接接続を拒否するため（compose.yml）、これらは fetch-proxy 経由でないと取得できない。
#   ./scripts/internal-feeds.sh   未設定の内部フィードの fetch_via_proxy を有効にして再取得する（冪等）
# 対象ホストは services/fetch-proxy/allowed-hosts から読む。認証は apply-theme.sh と同じ（scripts/lib.sh）。python3 が必要。
set -Eeuo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib.sh
source scripts/lib.sh

load_env
command -v python3 >/dev/null || { echo "error: python3 が必要です" >&2; exit 1; }
base_url="http://127.0.0.1:${MINIFLUX_LOCAL_PORT:-8080}"

auth_config() {
  miniflux_auth_config || { echo "error: MINIFLUX_API_KEY または ADMIN_PASSWORD を設定してください" >&2; return 1; }
}

api() {
  curl -sS --fail-with-body -m 20 -K <(auth_config) -H 'Content-Type: application/json' "$@"
}

feeds="$(api "${base_url}/v1/feeds")"
ids="$(FEEDS="$feeds" python3 - services/fetch-proxy/allowed-hosts <<'PY'
import json, os, re, sys
from urllib.parse import urlsplit

hosts = set()
for line in open(sys.argv[1], encoding="utf-8"):
    m = re.fullmatch(r"\^([A-Za-z0-9.-]+)\$", line.strip())
    if m:
        hosts.add(m.group(1).lower())

for feed in json.loads(os.environ["FEEDS"]):
    host = (urlsplit(feed["feed_url"]).hostname or "").lower()
    if host in hosts and not feed.get("fetch_via_proxy"):
        print(feed["id"])
PY
)"

count=0
for id in $ids; do
  api -X PUT -d '{"fetch_via_proxy": true}' "${base_url}/v1/feeds/${id}" >/dev/null
  api -X PUT "${base_url}/v1/feeds/${id}/refresh" >/dev/null \
    || echo "warning: feed ${id} の再取得に失敗しました（次回の巡回で再試行されます）" >&2
  count=$((count + 1))
done
echo "internal feeds: enabled fetch via proxy for ${count} feed(s)"
