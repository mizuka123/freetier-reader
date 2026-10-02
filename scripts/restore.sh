#!/usr/bin/env bash
# backup.sh が作ったアーカイブから復元する。
#   ./scripts/restore.sh backups/20261002T183000Z.tar.gz
# Miniflux と x-webhook-rss を停止してから復元し、起動後にヘルスチェックを待つ。
set -Eeuo pipefail

cd "$(dirname "$0")/.."
set -a; source .env; set +a

archive="${1:?usage: restore.sh <backup.tar.gz>}"
[[ -f "$archive" ]] || { echo "error: $archive not found" >&2; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
tar -C "$tmp" -xzf "$archive"
[[ -s "$tmp/miniflux.dump" ]] || { echo "error: miniflux.dump is missing or empty" >&2; exit 1; }

read -r -p "現在のデータを ${archive} の内容で置き換えます。続けますか? [y/N] " answer
[[ "$answer" == "y" ]] || exit 1

x_enabled=false
[[ ",${COMPOSE_PROFILES:-}," == *",x,"* ]] && x_enabled=true

echo "stopping writers..."
docker compose stop miniflux
$x_enabled && docker compose stop x-webhook-rss

echo "restoring PostgreSQL..."
docker compose up -d --wait postgres
docker compose exec -T postgres pg_restore -U miniflux -d miniflux --clean --if-exists --no-owner < "$tmp/miniflux.dump"

if $x_enabled && [[ -f "$tmp/x-webhook-rss.db" ]]; then
  echo "restoring x-webhook-rss SQLite..."
  # 停止中のボリュームに直接書き込む（WAL/SHM も削除して整合性を保つ）
  docker compose run --rm --no-deps -T --entrypoint sh -v "$tmp:/restore:ro" x-webhook-rss -c '
    set -e
    rm -f /data/x-webhook-rss.db-wal /data/x-webhook-rss.db-shm
    cp /restore/x-webhook-rss.db /data/x-webhook-rss.db
    node -e "const { DatabaseSync } = require(\"node:sqlite\");
      const db = new DatabaseSync(\"/data/x-webhook-rss.db\");
      const r = db.prepare(\"PRAGMA integrity_check\").get();
      if (Object.values(r)[0] !== \"ok\") { console.error(r); process.exit(1); }
      console.log(\"posts:\", db.prepare(\"SELECT COUNT(*) AS n FROM posts\").get().n);"'
fi

echo "starting services..."
docker compose up -d --wait
echo "restore completed"
