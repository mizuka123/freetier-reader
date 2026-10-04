#!/usr/bin/env bash
# compose 内部のフィード（rss-bridge / x-webhook-rss / morss / rsshub）に「プロキシ経由で取得」を設定する。
# Miniflux は内部ネットワークへの直接接続を拒否するため（compose.yml）、これらは fetch-proxy 経由でないと取得できない。
#   ./scripts/internal-feeds.sh   未設定の内部フィードの fetch_via_proxy を有効にして再取得する（冪等）
# 対象ホストは services/fetch-proxy/allowed-urls から読む。認証は apply-theme.sh と同じ（scripts/lib.sh）。python3 が必要。
# update.sh・restore.sh から実行する。失敗すると .state/internal-feeds.failed を作り、scripts/monitor.sh が通知する。
set -Eeuo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib.sh
source scripts/lib.sh

state_dir=".state"
failed_marker="${state_dir}/internal-feeds.failed"
mkdir -p "$state_dir"

fail() {
  echo "error: $1" >&2
  echo "$(date -u +%FT%TZ) $1" > "$failed_marker"
  exit 1
}
trap 'fail "internal-feeds failed at line $LINENO"' ERR

load_env
command -v python3 >/dev/null || fail "python3 が必要です"
miniflux_auth_config >/dev/null || fail "MINIFLUX_API_KEY または ADMIN_PASSWORD を設定してください"
base_url="http://127.0.0.1:${MINIFLUX_LOCAL_PORT:-8080}"

api() {
  curl -sS --fail-with-body -m 20 -K <(miniflux_auth_config) -H 'Content-Type: application/json' "$@"
}

feeds="$(api "${base_url}/v1/feeds")" || fail "Miniflux API に接続できません: ${feeds:-}"
ids="$(python3 - services/fetch-proxy/allowed-urls <(printf '%s' "$feeds") <<'PY'
import json, re, sys
from urllib.parse import urlsplit

# 「^http://<host>(:port)?/...」の形の行からホスト名を取り出す
hosts = set()
for line in open(sys.argv[1], encoding="utf-8"):
    line = line.strip()
    if line.startswith("^http://"):
        hosts.add(re.split(r"[(:/]", line[len("^http://"):])[0].lower())

for feed in json.load(open(sys.argv[2], encoding="utf-8")):
    host = (urlsplit(feed["feed_url"]).hostname or "").lower()
    if host in hosts and not feed.get("fetch_via_proxy"):
        print(feed["id"])
PY
)"

switched=0
failed=()
for id in $ids; do
  if ! api -X PUT -d '{"fetch_via_proxy": true}' "${base_url}/v1/feeds/${id}" >/dev/null; then
    failed+=("$id")
    continue
  fi
  switched=$((switched + 1))
  # 再取得の失敗は次回の巡回で再試行されるため警告のみ
  api -X PUT "${base_url}/v1/feeds/${id}/refresh" >/dev/null \
    || echo "warning: feed ${id} の再取得に失敗しました（次回の巡回で再試行されます）" >&2
done

echo "internal feeds: switched ${switched} feed(s) to the fetch proxy"
if ((${#failed[@]} > 0)); then
  fail "could not switch feed(s) ${failed[*]} to the fetch proxy"
fi
rm -f "$failed_marker"
