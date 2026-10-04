#!/usr/bin/env bash
# backup.sh が作ったアーカイブから復元する。
#   ./scripts/restore.sh [--yes] [--skip-x] [--skip-notion] backups/20261002T183000Z.tar.gz
# 1. 復元データを一時領域に用意して検証（PostgreSQL: 一時 DB miniflux_restore、SQLite: 一時ファイル）
# 2. すべてそろってから入れ替え、全サービスの起動を確認
# 3. 途中で失敗したら PostgreSQL・SQLite とも元に戻してサービスを起動し直す
# 元のデータは miniflux_before_restore_<時刻>（DB）と <サービス名>.db.before-restore-<時刻>（SQLite）として最新 1 世代だけ残す。
# SQLite を持つサービス: x-webhook-rss（プロファイル x）、star-to-notion（プロファイル notion）
set -Eeuo pipefail
umask 077

cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib.sh
source scripts/lib.sh
load_env
ops_lock

assume_yes=false
skip_x=false
skip_notion=false
while [[ $# -gt 1 ]]; do
  case "$1" in
    --yes) assume_yes=true ;;
    --skip-x) skip_x=true ;;
    --skip-notion) skip_notion=true ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done
archive="${1:?usage: restore.sh [--yes] [--skip-x] [--skip-notion] <backup.tar.gz>}"
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

# 復元する SQLite（サービス名。DB は /data/<サービス名>.db）と、件数の確認に使うテーブル
sqlite_services=()
declare -A sqlite_table=([x-webhook-rss]=posts [star-to-notion]=entries)
if profile_enabled x && ! $skip_x; then
  [[ -f "$tmp/x-webhook-rss.db" ]] || { echo "error: archive has no x-webhook-rss.db (use --skip-x to restore without it)" >&2; exit 1; }
  sqlite_services+=(x-webhook-rss)
fi
if profile_enabled notion && ! $skip_notion; then
  [[ -f "$tmp/star-to-notion.db" ]] || { echo "error: archive has no star-to-notion.db (use --skip-notion to restore without it)" >&2; exit 1; }
  sqlite_services+=(star-to-notion)
fi

if ! $assume_yes; then
  read -r -p "現在のデータを ${archive} の内容で置き換えます。続けますか? [y/N] " answer
  [[ "$answer" == "y" ]] || exit 1
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
old_db="miniflux_before_restore_${stamp}"
sq_db() { echo "/data/$1.db"; }
sq_staged() { echo "/data/$1.db.restore-${stamp}"; }
sq_old() { echo "/data/$1.db.before-restore-${stamp}"; }

psql_admin() { docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U miniflux -d postgres -qtAc "$1"; }
terminate() { psql_admin "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$1' AND pid <> pg_backend_pid();" >/dev/null; }
# 停止中のサービスのボリュームでコマンドを実行する。$1: サービス名、$2: コマンド
# （star-to-notion は cap_drop: ALL のため、root でもファイルの所有者の変更などに必要な権限を明示的に付ける）
sq_run() {
  docker compose run --rm --no-deps -T --user root --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
    --entrypoint sh -v "$tmp:/restore:ro" "$1" -c "set -e; $2"
}

# 入れ替えの進み具合（失敗時にどこまで戻すかの判定に使う）
pg_state=none   # none → old_renamed（miniflux を退避済み）→ swapped（復元 DB を miniflux に）
declare -A sq_state=()  # サービスごとに none → staged（一時ファイル作成済み）→ swapped（元の DB を退避済み。以降は退避分を戻す）

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
  local s db
  for s in "${sqlite_services[@]}"; do
    db="$(sq_db "$s")"
    case "${sq_state[$s]:-none}" in
      staged) sq_run "$s" "rm -f '$(sq_staged "$s")'" || true ;;
      swapped) sq_run "$s" "rm -f '${db}' '${db}-wal' '${db}-shm' '$(sq_staged "$s")' && mv '$(sq_old "$s")' '${db}'" \
        || echo "!! manual action: move $(sq_old "$s") back to ${db}" >&2 ;;
    esac
  done
  echo "元のデータに戻してサービスを起動し直します..." >&2
  docker compose up -d || true
  exit 1
}
trap 'on_error $LINENO' ERR

echo "stopping writers..."
docker compose stop miniflux
for s in "${sqlite_services[@]}"; do
  docker compose stop "$s"
done

# ---- 1. 一時領域に復元して検証 ----
echo "restoring PostgreSQL into a temporary database..."
docker compose up -d --wait postgres
psql_admin "DROP DATABASE IF EXISTS miniflux_restore;"
psql_admin "CREATE DATABASE miniflux_restore OWNER miniflux;"
docker compose exec -T postgres pg_restore -U miniflux -d miniflux_restore \
  --no-owner --single-transaction --exit-on-error < "$tmp/miniflux.dump"

for s in "${sqlite_services[@]}"; do
  echo "staging ${s} SQLite..."
  sq_state[$s]=staged
  staged="$(sq_staged "$s")"
  sq_run "$s" "cp '/restore/${s}.db' '${staged}' && chown node:node '${staged}'
    node -e \"const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync('${staged}');
      const r = db.prepare('PRAGMA integrity_check').get();
      if (Object.values(r)[0] !== 'ok') { console.error(r); process.exit(1); }
      console.log('${sqlite_table[$s]}:', db.prepare('SELECT COUNT(*) AS n FROM ${sqlite_table[$s]}').get().n);
      db.close();\""
done

# ---- 2. 入れ替え ----
echo "swapping data..."
terminate miniflux
psql_admin "ALTER DATABASE miniflux RENAME TO ${old_db};"
pg_state=old_renamed
psql_admin "ALTER DATABASE miniflux_restore RENAME TO miniflux;"
pg_state=swapped

for s in "${sqlite_services[@]}"; do
  db="$(sq_db "$s")"
  # 元の DB を退避した直後に状態を記録し、以降の失敗では退避分を必ず戻す
  sq_run "$s" "if [ -f '${db}' ]; then mv '${db}' '$(sq_old "$s")'; else : > '$(sq_old "$s")'; fi
    rm -f '${db}-wal' '${db}-shm'"
  sq_state[$s]=swapped
  sq_run "$s" "mv '$(sq_staged "$s")' '${db}'"
done

echo "starting services..."
docker compose up -d --wait
trap - ERR

# ---- 3. 古い退避データの整理（最新 1 世代だけ残す） ----
for db in $(psql_admin "SELECT datname FROM pg_database WHERE datname LIKE 'miniflux_before_restore_%' AND datname <> '${old_db}';"); do
  psql_admin "DROP DATABASE \"${db}\";" && echo "dropped old backup database ${db}"
done
for s in "${sqlite_services[@]}"; do
  sq_run "$s" "find /data -maxdepth 1 -name '${s}.db.before-restore-*' ! -name '$(basename "$(sq_old "$s")")' -delete" || true
done

# 復元したデータの内部フィードを fetch-proxy 経由にする（古いバックアップでは未設定のため）
./scripts/internal-feeds.sh || echo "warning: internal feeds were not switched to the fetch proxy (monitor.sh will report it)" >&2

echo "restore completed"
echo "以前のデータは ${old_db}（PostgreSQL）として残っています（確認後に削除: docs/operations.md）"
