#!/usr/bin/env bash
# PostgreSQL（Miniflux）と x-webhook-rss / star-to-notion の SQLite をバックアップする。
# - ローカル: ${BACKUP_DIR:-backups}/ に 7 世代
# - オフサイト: OCI_BACKUP_BUCKET があれば rclone（インスタンスプリンシパル認証）で OCI Object Storage へ
# - BACKUP_PING_URL があれば開始/成功/失敗を通知（Healthchecks.io 等の死活監視）
# 成功すると最後の行に作成したアーカイブのパスを出力する。
set -Eeuo pipefail
umask 077

cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib.sh
source scripts/lib.sh
load_env
ops_lock

RCLONE_IMAGE="rclone/rclone:1.75.1@sha256:45401ad7410db1d67ffdb58e19059ad20b0d8e0285a60e38bbec55cc1019c7a5"
backup_dir="${BACKUP_DIR:-backups}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
work="${backup_dir}/.work-${stamp}"
archive="${backup_dir}/${stamp}.tar.gz"
sqlite_tmp="/data/backup-${stamp}.db"

cleanup() {
  rm -rf "$work" "${archive}.partial"
  local service
  for service in x-webhook-rss star-to-notion; do
    docker compose exec -T "$service" rm -f "$sqlite_tmp" >/dev/null 2>&1 || true
  done
}

fail() {
  echo "error: $1" >&2
  ping_url "${BACKUP_PING_URL:-}" /fail "$1" || echo "warning: failed to ping monitor" >&2
  exit 1
}
trap 'fail "backup failed at line $LINENO"' ERR
trap cleanup EXIT

mkdir -p "$work"
ping_url "${BACKUP_PING_URL:-}" /start || echo "warning: failed to ping monitor" >&2

# ---- PostgreSQL ----
docker compose exec -T postgres pg_dump -U miniflux -Fc miniflux > "${work}/miniflux.dump"
# ダンプが壊れていないことを確認
docker compose exec -T postgres pg_restore -l < "${work}/miniflux.dump" > /dev/null

# ---- x-webhook-rss / star-to-notion (SQLite) ----
# 稼働中のサービスの中で VACUUM INTO で一貫したコピーを作り、取り出す。$1: サービス名（DB は /data/<サービス名>.db）
backup_sqlite() {
  local service="$1"
  if ! docker compose ps --status running --services | grep -qx "$service"; then
    fail "${service} is enabled but not running; SQLite backup is not possible"
  fi
  docker compose exec -T "$service" node -e "
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync('/data/${service}.db');
    db.exec(\"VACUUM INTO '${sqlite_tmp}'\");
    db.close();"
  docker compose cp "${service}:${sqlite_tmp}" "${work}/${service}.db"
  docker compose exec -T "$service" rm -f "$sqlite_tmp"
}
if profile_enabled x; then backup_sqlite x-webhook-rss; fi
if profile_enabled notion; then backup_sqlite star-to-notion; fi

# 書き込み途中のファイルを正規のバックアップと誤認しないよう .partial から rename する
tar -C "$work" -czf "${archive}.partial" .
mv "${archive}.partial" "$archive"
echo "local backup: ${archive} ($(du -h "$archive" | cut -f1))"

# ローカルは 7 世代保持
find "$backup_dir" -maxdepth 1 -name '*.tar.gz' -type f | sort -r | tail -n +8 | xargs -r rm -f

# ---- オフサイト ----
if [[ -n "${OCI_BACKUP_BUCKET:-}" ]]; then
  rclone() {
    # host ネットワークで実行（コンテナからのメタデータアクセスは egress guard で遮断しているため）
    docker run --rm --network host \
      -v "$(cd "$backup_dir" && pwd):/backups:ro" \
      -e RCLONE_CONFIG_OOS_TYPE=oracleobjectstorage \
      -e RCLONE_CONFIG_OOS_PROVIDER=instance_principal_auth \
      -e RCLONE_CONFIG_OOS_NAMESPACE="$OCI_BACKUP_NAMESPACE" \
      -e RCLONE_CONFIG_OOS_COMPARTMENT="$OCI_COMPARTMENT_OCID" \
      -e RCLONE_CONFIG_OOS_REGION="$OCI_REGION" \
      "$RCLONE_IMAGE" "$@"
  }
  rclone copyto "/backups/${stamp}.tar.gz" "oos:${OCI_BACKUP_BUCKET}/${stamp}.tar.gz" --checksum
  # アップロード結果を確認（サイズが一致すること）
  remote_size="$(rclone size --json "oos:${OCI_BACKUP_BUCKET}/${stamp}.tar.gz" | sed -n 's/.*"bytes":\([0-9]*\).*/\1/p')"
  [[ "$remote_size" == "$(stat -c %s "$archive")" ]] || fail "offsite upload size mismatch (${remote_size:-none})"
  echo "offsite backup: oos:${OCI_BACKUP_BUCKET}/${stamp}.tar.gz"
  # monitor.sh がオフサイトの成功を確認するためのマーカー
  echo "$stamp" > "${backup_dir}/.last-offsite-ok"
  # 保持期間はバケットのライフサイクルポリシー（Terraform: backup_retention_days）で管理
else
  echo "WARNING: OCI_BACKUP_BUCKET is not set; no offsite copy was made (VM loss = data loss)" >&2
fi

echo "$stamp" > "${backup_dir}/.last-local-ok"
ping_url "${BACKUP_PING_URL:-}" "" || echo "warning: failed to ping monitor" >&2
echo "backup completed"
echo "$archive"
