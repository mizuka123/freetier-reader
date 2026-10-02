#!/usr/bin/env bash
# リポジトリとコンテナを更新する。失敗したら直前のコミットに戻して起動し直す。
#   ./scripts/update.sh            # 現在のブランチを fast-forward
# AUTO_UPDATE=true の場合、cloud-init が週 1 回 cron で実行する。
set -Eeuo pipefail

cd "$(dirname "$0")/.."
set -a; source .env; set +a

before="$(git rev-parse HEAD)"
echo "backup before update..."
./scripts/backup.sh

git fetch --quiet origin
git merge --ff-only --quiet "@{u}"
after="$(git rev-parse HEAD)"
echo "repo: ${before:0:7} -> ${after:0:7}"

rollback() {
  echo "error: update failed, rolling back to ${before:0:7}" >&2
  git reset --hard --quiet "$before"
  docker compose up -d --build --wait || true
  if [[ -n "${HEALTHCHECK_PING_URL:-}" ]]; then
    curl -fsS -m 10 -o /dev/null --data-raw "update failed; rolled back to ${before:0:7}" "${HEALTHCHECK_PING_URL}/fail" || true
  fi
  exit 1
}
trap rollback ERR

docker compose pull --ignore-buildable
docker compose up -d --build --wait --remove-orphans
docker image prune -f >/dev/null
echo "update completed"
