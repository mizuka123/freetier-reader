#!/usr/bin/env bash
# リポジトリとコンテナを更新する。
#   ./scripts/update.sh          手動更新
#   ./scripts/update.sh --auto   cron からの自動更新（DB スキーマが変わりうる更新は行わず通知のみ）
# 失敗したら直前のコミットに戻して起動し直す。Miniflux / PostgreSQL のイメージが変わる更新では
# マイグレーション済みの DB を旧版で使わないよう、更新前のバックアップから必ず復元する。
set -Eeuo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib.sh
source scripts/lib.sh

notify_fail() {
  echo "error: $1" >&2
  ping_url "${HEALTHCHECK_PING_URL:-}" /fail "update: $1" || echo "warning: failed to ping monitor" >&2
}
trap 'notify_fail "update failed before applying changes (line $LINENO)"; exit 1' ERR

load_env
auto=false
[[ "${1:-}" == "--auto" ]] && auto=true
ops_lock

if [[ -n "$(git status --porcelain)" ]]; then
  notify_fail "the repository has local changes or untracked files; commit, discard or .gitignore them before updating"
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

# DB を持つサービス（Miniflux / PostgreSQL）のイメージが変わるか
db_images_changed=false
if git diff "$before" "$target" -- compose.yml | grep -qE '^[+-][[:space:]]+image: (miniflux|postgres)/?'; then
  db_images_changed=true
fi
if $auto && $db_images_changed; then
  notify_fail "Miniflux/PostgreSQL image changed in ${target:0:7}; run scripts/update.sh manually"
  exit 1
fi

echo "backup before update..."
pre_update_archive="$(./scripts/backup.sh | tail -n 1)"

git merge --ff-only --quiet "$target"
echo "repo: ${before:0:7} -> ${target:0:7}"

rollback() {
  trap - ERR
  set +e
  echo "error: update failed, rolling back to ${before:0:7}" >&2
  if ! git reset --hard --quiet "$before"; then
    notify_fail "update to ${target:0:7} failed and ROLLBACK FAILED (git reset); manual recovery required (backup: ${pre_update_archive})"
    exit 1
  fi
  if ! $db_images_changed && docker compose up -d --build --wait; then
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
# テーマの CSS が更新されている可能性があるため再適用。失敗しても更新自体は成功扱いとし、
# apply-theme.sh が作る .state/theme.failed を monitor.sh が通知する
if ./scripts/apply-theme.sh; then
  echo "update completed"
else
  echo "update completed with warnings: theme was not applied (monitor.sh will report it)" >&2
fi
