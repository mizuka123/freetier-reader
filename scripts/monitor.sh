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
# Health はヘルスチェックのないサービスでは空になるため、空白ではなく | で区切る
if ! actual="$(docker compose ps -a --format '{{.Service}}|{{.State}}|{{.Health}}|{{.ID}}' 2>&1)"; then
  problems+=("compose: ps failed: ${actual}")
  actual=""
fi

now="$(date +%s)"
for service in $expected; do
  line="$(grep -E "^${service}\|" <<<"$actual" | head -n 1)"
  if [[ -z "$line" ]]; then
    problems+=("${service}: missing")
    continue
  fi
  IFS='|' read -r _ state health id <<<"$line"
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
  # 503 でも本文（どのアカウントが途絶えているか）を取得するため node で問い合わせる
  status="$(docker compose exec -T x-webhook-rss node -e "
    fetch('http://127.0.0.1:8080/status').then(async (r) => { console.log(r.status, await r.text()); })
      .catch((e) => { console.log('ERR', e.message); });" 2>&1)" || status="ERR exec failed: ${status}"
  case "$status" in
    200\ *) ;;
    503\ *) problems+=("x-webhook-rss: no webhook from IFTTT within X_STALE_HOURS: ${status#503 }") ;;
    *) problems+=("x-webhook-rss: /status check failed: ${status}") ;;
  esac
fi

# ---- バックアップ ----
backup_dir="${BACKUP_DIR:-backups}"
# 初回バックアップ前（ローカルの成功マーカーがまだない）は、構築から 26 時間までは判定しない
first_marker="${backup_dir}/.first-check"
[[ -e "${backup_dir}/.last-local-ok" || -e "$first_marker" ]] || { mkdir -p "$backup_dir"; touch "$first_marker"; }
if [[ -e "${backup_dir}/.last-local-ok" || -n "$(find "$first_marker" -mmin +1560 2>/dev/null)" ]]; then
  [[ -n "$(find "$backup_dir" -maxdepth 1 -name .last-local-ok -mmin -1560 2>/dev/null)" ]] \
    || problems+=("backup: no successful local backup in the last 26 hours")
  if [[ -n "${OCI_BACKUP_BUCKET:-}" ]]; then
    [[ -n "$(find "$backup_dir" -maxdepth 1 -name .last-offsite-ok -mmin -1560 2>/dev/null)" ]] \
      || problems+=("backup: no successful offsite backup in the last 26 hours")
  fi
fi

# ---- ディスク容量（Docker のデータとバックアップがある領域） ----
for path in "$backup_dir" /var/lib/docker /srv/freetier-reader; do
  [[ -e "$path" ]] || continue
  used="$(df -P "$path" | awk 'NR == 2 { gsub("%", "", $5); print $5 }')"
  (( used < 90 )) || problems+=("disk: ${path} is ${used}% full")
done

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
