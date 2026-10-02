#!/usr/bin/env bash
# PostgreSQL（Miniflux）と x-webhook-rss の SQLite をバックアップする。
# - ローカル: ${BACKUP_DIR:-backups}/ に 7 世代
# - オフサイト: OCI_BACKUP_BUCKET があれば rclone（インスタンスプリンシパル認証）で OCI Object Storage へ
# - BACKUP_PING_URL があれば成功/失敗を通知（Healthchecks.io 等の死活監視）
set -Eeuo pipefail

cd "$(dirname "$0")/.."
set -a; source .env; set +a

RCLONE_IMAGE="rclone/rclone:1.75.1@sha256:45401ad7410db1d67ffdb58e19059ad20b0d8e0285a60e38bbec55cc1019c7a5"
backup_dir="${BACKUP_DIR:-backups}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
work="${backup_dir}/.work-${stamp}"
x_expected=false
[[ ",${COMPOSE_PROFILES:-}," == *",x,"* ]] && x_expected=true

ping() {
  [[ -n "${BACKUP_PING_URL:-}" ]] || return 0
  curl -fsS -m 10 --retry 3 -o /dev/null "${BACKUP_PING_URL}$1" || echo "warning: failed to ping monitor" >&2
}

cleanup() {
  rm -rf "$work"
  if $x_expected; then
    docker compose exec -T x-webhook-rss rm -f /data/backup.db >/dev/null 2>&1 || true
  fi
}

on_error() {
  echo "error: backup failed at line $1" >&2
  ping /fail
}
trap 'on_error $LINENO' ERR
trap cleanup EXIT

mkdir -p "$work"
ping /start

# ---- PostgreSQL ----
docker compose exec -T postgres pg_dump -U miniflux -Fc miniflux > "${work}/miniflux.dump"
# ダンプが壊れていないことを確認
docker compose exec -T postgres pg_restore -l < "${work}/miniflux.dump" > /dev/null

# ---- x-webhook-rss (SQLite) ----
if $x_expected; then
  if ! docker compose ps --status running --services | grep -qx x-webhook-rss; then
    echo "error: x-webhook-rss is enabled but not running; SQLite backup is not possible" >&2
    exit 1
  fi
  docker compose exec -T x-webhook-rss rm -f /data/backup.db
  docker compose exec -T x-webhook-rss node -e "
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync('/data/x-webhook-rss.db');
    db.exec(\"VACUUM INTO '/data/backup.db'\");
    db.close();"
  docker compose cp x-webhook-rss:/data/backup.db "${work}/x-webhook-rss.db"
fi

archive="${backup_dir}/${stamp}.tar.gz"
tar -C "$work" -czf "$archive" .
echo "local backup: ${archive} ($(du -h "$archive" | cut -f1))"

# ローカルは 7 世代保持
find "$backup_dir" -maxdepth 1 -name '*.tar.gz' -type f | sort -r | tail -n +8 | xargs -r rm -f

# ---- オフサイト ----
if [[ -n "${OCI_BACKUP_BUCKET:-}" ]]; then
  # host ネットワークで実行（コンテナからのメタデータアクセスは egress guard で遮断しているため）
  docker run --rm --network host \
    -v "$(cd "$backup_dir" && pwd):/backups:ro" \
    -e RCLONE_CONFIG_OOS_TYPE=oracleobjectstorage \
    -e RCLONE_CONFIG_OOS_PROVIDER=instance_principal_auth \
    -e RCLONE_CONFIG_OOS_NAMESPACE="$OCI_BACKUP_NAMESPACE" \
    -e RCLONE_CONFIG_OOS_COMPARTMENT="$OCI_COMPARTMENT_OCID" \
    -e RCLONE_CONFIG_OOS_REGION="$OCI_REGION" \
    "$RCLONE_IMAGE" \
    copyto "/backups/${stamp}.tar.gz" "oos:${OCI_BACKUP_BUCKET}/${stamp}.tar.gz" --checksum
  echo "offsite backup: oos:${OCI_BACKUP_BUCKET}/${stamp}.tar.gz"
  # 保持期間はバケットのライフサイクルポリシー（Terraform: backup_retention_days）で管理
else
  echo "WARNING: OCI_BACKUP_BUCKET is not set; no offsite copy was made (VM loss = data loss)" >&2
fi

ping ""
echo "backup completed"
