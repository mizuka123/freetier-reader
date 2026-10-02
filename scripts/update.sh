#!/usr/bin/env bash
# リポジトリとコンテナを更新する。
#   ./scripts/update.sh          手動更新
#   ./scripts/update.sh --auto   cron からの自動更新（DB スキーマが変わりうる更新は行わず通知のみ）
# 失敗したら直前のコミットに戻して起動し直し、それでも起動しなければ更新前のバックアップから復元する。
set -Eeuo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib.sh
source scripts/lib.sh
load_env

auto=false
[[ "${1:-}" == "--auto" ]] && auto=true

notify_fail() {
  echo "error: $1" >&2
  ping_url "${HEALTHCHECK_PING_URL:-}" /fail "update: $1" || echo "warning: failed to ping monitor" >&2
}
trap 'notify_fail "update failed before applying changes (line $LINENO)"; exit 1' ERR

ops_lock

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  notify_fail "local changes in the repository; commit or discard them before updating"
  exit 1
fi

before="$(git rev-parse HEAD)"
git fetch --quiet origin
target="$(git rev-parse "@{u}")"
if [[ "$before" == "$target" ]]; then
  echo "already up to date (${before:0:7})"
  exit 0
fi
git merge-base --is-ancestor "$before" "$target" || { notify_fail "upstream is not a fast-forward of ${before:0:7}"; exit 1; }

# DB を持つサービス（Miniflux / PostgreSQL）のイメージが変わる更新は、マイグレーションで
# 旧版に戻せなくなる可能性があるため自動更新では行わない
if $auto && git diff --name-only "$before" "$target" -- compose.yml | grep -q . \
  && git diff "$before" "$target" -- compose.yml | grep -qE '^[+-][[:space:]]+image: (miniflux|postgres)/?'; then
  notify_fail "Miniflux/PostgreSQL image changed in ${target:0:7}; run scripts/update.sh manually"
  exit 1
fi

echo "backup before update..."
pre_update_archive="$(./scripts/backup.sh | tail -n 1)"

git merge --ff-only --quiet "$target"
echo "repo: ${before:0:7} -> ${target:0:7}"

rollback() {
  trap - ERR
  echo "error: update failed, rolling back to ${before:0:7}" >&2
  git reset --hard --quiet "$before"
  if docker compose up -d --build --wait; then
    notify_fail "update to ${target:0:7} failed; rolled back to ${before:0:7}"
  elif ./scripts/restore.sh --yes "$pre_update_archive"; then
    notify_fail "update to ${target:0:7} failed; rolled back to ${before:0:7} and restored ${pre_update_archive}"
  else
    notify_fail "update to ${target:0:7} failed and ROLLBACK ALSO FAILED; manual recovery required (backup: ${pre_update_archive})"
  fi
  exit 1
}
trap rollback ERR

docker compose pull --ignore-buildable
docker compose up -d --build --wait --remove-orphans
trap - ERR
docker image prune -f >/dev/null || true
echo "update completed"
