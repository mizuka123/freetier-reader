#!/usr/bin/env bash
# PostgreSQL（Miniflux）と x-webhook-rss の SQLite をバックアップする。
# OCI_BACKUP_BUCKET が設定されていれば OCI Object Storage にアップロードする
# （VM のインスタンスプリンシパルで認証。権限は Terraform が付与）。
set -euo pipefail

cd "$(dirname "$0")/.."
set -a; source .env; set +a

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="backups/${stamp}"
mkdir -p "$out"

docker compose exec -T postgres pg_dump -U miniflux -Fc miniflux > "${out}/miniflux.dump"

if docker compose ps --status running --services | grep -qx x-webhook-rss; then
  docker compose exec -T x-webhook-rss node -e "
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync('/data/x-webhook-rss.db');
    db.exec(\"VACUUM INTO '/data/backup.db'\");
    db.close();"
  docker compose cp x-webhook-rss:/data/backup.db "${out}/x-webhook-rss.db"
  docker compose exec -T x-webhook-rss rm -f /data/backup.db
fi

tar -C backups -czf "backups/${stamp}.tar.gz" "${stamp}"
rm -rf "$out"

# ローカルは 7 世代保持
ls -1t backups/*.tar.gz | tail -n +8 | xargs -r rm -f

if [[ -n "${OCI_BACKUP_BUCKET:-}" ]]; then
  # host ネットワークで実行（コンテナからのメタデータアクセスは cloud-init で遮断しているため）
  docker run --rm --network host \
    -v "$PWD/backups:/backups:ro" \
    ghcr.io/oracle/oci-cli:latest \
    os object put --auth instance_principal \
      --namespace "$OCI_BACKUP_NAMESPACE" \
      --bucket-name "$OCI_BACKUP_BUCKET" \
      --file "/backups/${stamp}.tar.gz" \
      --name "${stamp}.tar.gz" --force
  # バケット側はライフサイクルポリシーで 7 日経過したオブジェクトを削除
fi

echo "backup completed: backups/${stamp}.tar.gz"
