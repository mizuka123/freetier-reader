#!/usr/bin/env bash
# backup.sh が作ったアーカイブから復元する。
#   ./scripts/restore.sh [--yes] [--skip-x] backups/20261002T183000Z.tar.gz
# 1. 復元データを一時領域に用意して検証（PostgreSQL: 一時 DB miniflux_restore、SQLite: 一時ファイル）
# 2. 両方そろってから入れ替え、全サービスの起動を確認
# 3. 途中で失敗したら PostgreSQL・SQLite とも元に戻してサービスを起動し直す
# 元のデータは miniflux_before_restore_<時刻>（DB）と x-webhook-rss.db.before-restore-<時刻> として最新 1 世代だけ残す。
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

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# ---- アーカイブの検証（絶対パス・..・リンク・特殊ファイルを拒否） ----
members="$(tar -tvzf "$archive")"
while IFS= read -r entry; do
  type="${entry:0:1}"
  name="${entry##* }"
  if [[ "$type" != "-" && "$type" != "d" ]] || [[ "$name" == /* || "$name" == *..* ]]; then
    echo "error: unsafe archive member: $entry" >&2
    exit 1
  fi
done <<<"$members"

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
old_db="miniflux_before_restore_${stamp}"
x_db=/data/x-webhook-rss.db
x_staged="${x_db}.restore-${stamp}"
x_old="${x_db}.before-restore-${stamp}"

psql_admin() { docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U miniflux -d postgres -qtAc "$1"; }
terminate() { psql_admin "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$1' AND pid <> pg_backend_pid();" >/dev/null; }
# 停止中の x-webhook-rss のボリュームでコマンドを実行する
x_run() { docker compose run --rm --no-deps -T --user root --entrypoint sh -v "$tmp:/restore:ro" x-webhook-rss -c "set -e; $1"; }

# 入れ替えの進み具合（失敗時にどこまで戻すかの判定に使う）
pg_state=none   # none → old_renamed（miniflux を退避済み）→ swapped（復元 DB を miniflux に）
x_state=none    # none → staged（一時ファイル作成済み）→ swapped（元の DB を退避済み。以降は退避分を戻す）

on_error() {
  trap - ERR
  echo "error: restore failed at line $1; reverting..." >&2
  case "$pg_state" in
    none)
      psql_admin "DROP DATABASE IF EXISTS miniflux_restore;" || true ;;
    old_renamed)
      psql_admin "ALTER DATABASE ${old_db} RENAME TO miniflux;" || echo "!! manual action: rename ${old_db} back to miniflux" >&2
      psql_admin "DROP DATABASE IF EXISTS miniflux_restore;" || true ;;
    swapped)
      docker compose stop miniflux >/dev/null 2>&1 || true
      terminate miniflux || true
      { psql_admin "ALTER DATABASE miniflux RENAME TO miniflux_failed_restore_${stamp};" \
        && psql_admin "ALTER DATABASE ${old_db} RENAME TO miniflux;"; } \
        || echo "!! manual action: restore ${old_db} as miniflux" >&2 ;;
  esac
  case "$x_state" in
    staged) x_run "rm -f '${x_staged}'" || true ;;
    swapped) x_run "rm -f '${x_db}' '${x_db}-wal' '${x_db}-shm' '${x_staged}' && mv '${x_old}' '${x_db}'" \
      || echo "!! manual action: move ${x_old} back to ${x_db}" >&2 ;;
  esac
  echo "元のデータに戻してサービスを起動し直します..." >&2
  docker compose up -d || true
  exit 1
}
trap 'on_error $LINENO' ERR

echo "stopping writers..."
docker compose stop miniflux
$restore_x && docker compose stop x-webhook-rss

# ---- 1. 一時領域に復元して検証 ----
echo "restoring PostgreSQL into a temporary database..."
docker compose up -d --wait postgres
psql_admin "DROP DATABASE IF EXISTS miniflux_restore;"
psql_admin "CREATE DATABASE miniflux_restore OWNER miniflux;"
docker compose exec -T postgres pg_restore -U miniflux -d miniflux_restore \
  --no-owner --single-transaction --exit-on-error < "$tmp/miniflux.dump"

if $restore_x; then
  echo "staging x-webhook-rss SQLite..."
  x_state=staged
  x_run "cp /restore/x-webhook-rss.db '${x_staged}' && chown node:node '${x_staged}'
    node -e \"const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync('${x_staged}');
      const r = db.prepare('PRAGMA integrity_check').get();
      if (Object.values(r)[0] !== 'ok') { console.error(r); process.exit(1); }
      console.log('posts:', db.prepare('SELECT COUNT(*) AS n FROM posts').get().n);
      db.close();\""
fi

# ---- 2. 入れ替え ----
echo "swapping data..."
terminate miniflux
psql_admin "ALTER DATABASE miniflux RENAME TO ${old_db};"
pg_state=old_renamed
psql_admin "ALTER DATABASE miniflux_restore RENAME TO miniflux;"
pg_state=swapped

if $restore_x; then
  # 元の DB を退避した直後に状態を記録し、以降の失敗では退避分を必ず戻す
  x_run "if [ -f '${x_db}' ]; then mv '${x_db}' '${x_old}'; else : > '${x_old}'; fi
    rm -f '${x_db}-wal' '${x_db}-shm'"
  x_state=swapped
  x_run "mv '${x_staged}' '${x_db}'"
fi

echo "starting services..."
docker compose up -d --wait
trap - ERR

# ---- 3. 古い退避データの整理（最新 1 世代だけ残す） ----
for db in $(psql_admin "SELECT datname FROM pg_database WHERE datname LIKE 'miniflux_before_restore_%' AND datname <> '${old_db}';"); do
  psql_admin "DROP DATABASE \"${db}\";" && echo "dropped old backup database ${db}"
done
if $restore_x; then
  x_run "find /data -maxdepth 1 -name 'x-webhook-rss.db.before-restore-*' ! -name '$(basename "$x_old")' -delete" || true
fi

# 復元したデータの内部フィードを fetch-proxy 経由にする（古いバックアップでは未設定のため）
./scripts/internal-feeds.sh || echo "warning: internal feeds were not switched to the fetch proxy (monitor.sh will report it)" >&2

echo "restore completed"
echo "以前のデータは ${old_db}（PostgreSQL）として残っています（確認後に削除: docs/operations.md）"
