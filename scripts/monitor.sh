#!/usr/bin/env bash
# 稼働状況を確認し、HEALTHCHECK_PING_URL（Healthchecks.io 等）へ成功/失敗を通知する。cron で 10 分ごとに実行。
# - 構築スクリプト（cloud-init）が失敗していないか
# - 有効なプロファイルの全サービスが存在し running / healthy か（starting が 10 分を超えたら異常）
# - x-webhook-rss の /status（X_STALE_HOURS を超えて IFTTT から受信がなければ異常）
# - 最新のローカルバックアップが 26 時間以内か
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
# shellcheck source=scripts/lib.sh
source scripts/lib.sh
load_env || exit 1

problems=()

[[ -e /var/lib/freetier-reader/bootstrap.failed ]] && problems+=("bootstrap: failed (see /var/log/freetier-reader-bootstrap.log)")

if ! expected="$(docker compose config --services 2>&1)"; then
  problems+=("compose: config failed: ${expected}")
  expected=""
fi
if ! actual="$(docker compose ps -a --format '{{.Service}} {{.State}} {{.Health}} {{.ID}}' 2>&1)"; then
  problems+=("compose: ps failed: ${actual}")
  actual=""
fi

now="$(date +%s)"
for service in $expected; do
  line="$(grep -E "^${service} " <<<"$actual" | head -n 1)"
  if [[ -z "$line" ]]; then
    problems+=("${service}: missing")
    continue
  fi
  read -r _ state health id <<<"$line"
  [[ "$state" == "running" ]] || problems+=("${service}: ${state}")
  case "$health" in
    "" | healthy) ;;
    starting)
      started="$(docker inspect -f '{{.State.StartedAt}}' "$id" 2>/dev/null)"
      if [[ -n "$started" ]] && (( now - $(date -d "$started" +%s) > 600 )); then
        problems+=("${service}: starting for more than 10 minutes")
      fi
      ;;
    *) problems+=("${service}: ${health}") ;;
  esac
done

if profile_enabled x && grep -qx x-webhook-rss <<<"$expected"; then
  if ! status="$(docker compose exec -T x-webhook-rss wget -qO- http://127.0.0.1:8080/status 2>&1)"; then
    problems+=("x-webhook-rss: no webhook from IFTTT within X_STALE_HOURS, or service down: ${status}")
  fi
fi

backup_dir="${BACKUP_DIR:-backups}"
latest="$(find "$backup_dir" -maxdepth 1 -name '*.tar.gz' -type f -mmin -1560 2>/dev/null | head -n 1)"
# 構築直後（.env 作成から 26 時間以内）は初回バックアップ前なので判定しない
installed_recently="$(find . -maxdepth 1 -name .env -mmin -1560 2>/dev/null)"
if [[ -z "$latest" && -z "$installed_recently" ]]; then
  problems+=("backup: no local backup in the last 26 hours")
fi

if ((${#problems[@]})); then
  printf '%s\n' "${problems[@]}" >&2
  ping_url "${HEALTHCHECK_PING_URL:-}" /fail "$(printf '%s\n' "${problems[@]}")" || echo "warning: failed to ping monitor" >&2
  exit 1
fi

if ! ping_url "${HEALTHCHECK_PING_URL:-}" ""; then
  echo "error: all checks passed but the monitor ping failed" >&2
  exit 1
fi
echo "ok"
