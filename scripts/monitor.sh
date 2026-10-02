#!/usr/bin/env bash
# 稼働状況を確認し、HEALTHCHECK_PING_URL（Healthchecks.io 等）へ成功/失敗を通知する。cron で 10 分ごとに実行。
# - 全コンテナが running かつ healthy（ヘルスチェックがあるもの）
# - x-webhook-rss の /healthz（X_STALE_HOURS を超えて IFTTT から受信がなければ失敗）
# - 最新のローカルバックアップが 26 時間以内
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
set -a; source .env; set +a

problems=()

while read -r name state health; do
  [[ "$state" == "running" ]] || problems+=("${name}: ${state}")
  [[ -z "$health" || "$health" == "healthy" || "$health" == "starting" ]] || problems+=("${name}: ${health}")
done < <(docker compose ps -a --format '{{.Service}} {{.State}} {{.Health}}')

if [[ ",${COMPOSE_PROFILES:-}," == *",x,"* ]]; then
  if ! docker compose exec -T x-webhook-rss wget -qO- http://127.0.0.1:8080/healthz >/dev/null 2>&1; then
    problems+=("x-webhook-rss: /healthz failed (stale or down)")
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
  [[ -n "${HEALTHCHECK_PING_URL:-}" ]] && printf '%s\n' "${problems[@]}" \
    | curl -fsS -m 10 --retry 3 -o /dev/null --data-binary @- "${HEALTHCHECK_PING_URL}/fail"
  exit 1
fi

[[ -n "${HEALTHCHECK_PING_URL:-}" ]] && curl -fsS -m 10 --retry 3 -o /dev/null "${HEALTHCHECK_PING_URL}"
echo "ok"
