#!/usr/bin/env bash
# backup.sh が作ったアーカイブから復元する。
#   ./scripts/restore.sh [--yes] [--skip-x] backups/20261002T183000Z.tar.gz
# - PostgreSQL は一時 DB（miniflux_restore）に復元・検証してから入れ替える。元の DB は
#   miniflux_before_restore_<時刻> として残す（不要になったら docs/operations.md の手順で削除）。
# - 失敗した場合は元の DB のまま、停止したサービスを起動し直す。
set -Eeuo pipefail
umask 077

cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib.sh
source scripts/lib.sh
load_env
ops_lock

assume_yes=false
skip_x=false
while [[ $# -gt 1 ]]; do
  case "$1" in
    --yes) assume_yes=true ;;
    --skip-x) skip_x=true ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done
archive="${1:?usage: restore.sh [--yes] [--skip-x] <backup.tar.gz>}"
[[ -f "$archive" ]] || { echo "error: $archive not found" >&2; exit 1; }

# ---- アーカイブの検証（絶対パス・..・リンク・特殊ファイルを拒否） ----
while IFS= read -r entry; do
  type="${entry:0:1}"
  name="${entry##* }"
  if [[ "$type" != "-" && "$type" != "d" ]] || [[ "$name" == /* || "$name" == *..* ]]; then
    echo "error: unsafe archive member: $entry" >&2
    exit 1
  fi
done < <(tar -tvzf "$archive")

tmp="$(mktemp -d)"
chmod 755 "$tmp"
tar -C "$tmp" --no-same-owner -xzf "$archive"
[[ -s "$tmp/miniflux.dump" ]] || { echo "error: miniflux.dump is missing or empty" >&2; exit 1; }

restore_x=false
if profile_enabled x && ! $skip_x; then
  [[ -f "$tmp/x-webhook-rss.db" ]] || { echo "error: archive has no x-webhook-rss.db (use --skip-x to restore Miniflux only)" >&2; exit 1; }
  restore_x=true
fi

if ! $assume_yes; then
  read -r -p "現在のデータを ${archive} の内容で置き換えます。続けますか? [y/N] " answer
  [[ "$answer" == "y" ]] || exit 1
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
psql_admin() { docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U miniflux -d postgres -qc "$1"; }

swapped=false
on_error() {
  echo "error: restore failed at line $1" >&2
  if ! $swapped; then
    psql_admin "DROP DATABASE IF EXISTS miniflux_restore;" || true
    echo "元の PostgreSQL データはそのままです。" >&2
  fi
  echo "サービスを起動し直します..." >&2
  docker compose up -d || true
  rm -rf "$tmp"
}
trap 'on_error $LINENO' ERR
trap 'rm -rf "$tmp"' EXIT

echo "stopping writers..."
docker compose stop miniflux
$restore_x && docker compose stop x-webhook-rss

echo "restoring PostgreSQL into a temporary database..."
docker compose up -d --wait postgres
psql_admin "DROP DATABASE IF EXISTS miniflux_restore;"
psql_admin "CREATE DATABASE miniflux_restore OWNER miniflux;"
docker compose exec -T postgres pg_restore -U miniflux -d miniflux_restore \
  --no-owner --single-transaction --exit-on-error < "$tmp/miniflux.dump"

echo "swapping databases..."
psql_admin "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'miniflux' AND pid <> pg_backend_pid();" >/dev/null
psql_admin "ALTER DATABASE miniflux RENAME TO miniflux_before_restore_${stamp};"
psql_admin "ALTER DATABASE miniflux_restore RENAME TO miniflux;"
swapped=true

if $restore_x; then
  echo "restoring x-webhook-rss SQLite..."
  # 停止中のボリュームに直接書き込む（WAL/SHM も削除して整合性を保つ）
  docker compose run --rm --no-deps -T --user root --entrypoint sh -v "$tmp:/restore:ro" x-webhook-rss -c '
    set -e
    rm -f /data/x-webhook-rss.db-wal /data/x-webhook-rss.db-shm
    cp /restore/x-webhook-rss.db /data/x-webhook-rss.db
    chown node:node /data/x-webhook-rss.db
    node -e "const { DatabaseSync } = require(\"node:sqlite\");
      const db = new DatabaseSync(\"/data/x-webhook-rss.db\");
      const r = db.prepare(\"PRAGMA integrity_check\").get();
      if (Object.values(r)[0] !== \"ok\") { console.error(r); process.exit(1); }
      console.log(\"posts:\", db.prepare(\"SELECT COUNT(*) AS n FROM posts\").get().n);"'
fi

echo "starting services..."
docker compose up -d --wait
echo "restore completed"
echo "以前の DB は miniflux_before_restore_${stamp} として残っています（確認後に削除: docs/operations.md）"
