#!/usr/bin/env bash
# scripts/*.sh の共通処理。各スクリプトから source して使う。

# .env を shell として評価せずに読み込む（値に & ; $() などが含まれても安全）
load_env() {
  local file="${1:-.env}" line key value
  [[ -f "$file" ]] || { echo "error: $file not found (run scripts/init.sh)" >&2; return 1; }
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    key="${line%%=*}"
    value="${line#*=}"
    [[ "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]] || continue
    export "$key=$value"
  done < "$file"
}

# COMPOSE_PROFILES に指定のプロファイルが含まれるか
profile_enabled() {
  [[ ",${COMPOSE_PROFILES:-}," == *",$1,"* ]]
}

# backup / restore / update の同時実行を防ぐ（入れ子で呼ばれた場合は取得済みとして扱う）
ops_lock() {
  [[ -n "${FTR_LOCK_HELD:-}" ]] && return 0
  exec 9>"${TMPDIR:-/tmp}/freetier-reader-ops.lock"
  if ! flock -w 900 9; then
    echo "error: another backup/restore/update is running" >&2
    return 1
  fi
  export FTR_LOCK_HELD=1
}

# Healthchecks.io 等へ通知する。$1: ping URL、$2: サフィックス（"" / /start / /fail）、$3: 本文（任意）
ping_url() {
  local url="$1" suffix="${2:-}" body="${3:-}"
  [[ -n "$url" ]] || return 0
  if [[ -n "$body" ]]; then
    curl -fsS -m 10 --retry 3 -o /dev/null --data-raw "$body" "${url}${suffix}"
  else
    curl -fsS -m 10 --retry 3 -o /dev/null "${url}${suffix}"
  fi
}

# Miniflux API の認証情報を curl の設定ファイル形式で出力する（" と \ をエスケープ）。
# MINIFLUX_API_KEY があればそれを、なければ ADMIN_USERNAME / ADMIN_PASSWORD を使う。認証情報がなければ 1 を返す。
# 認証情報がプロセス一覧に出ないよう、curl -K <(miniflux_auth_config) で渡す。
miniflux_auth_config() {
  local value
  if [[ -n "${MINIFLUX_API_KEY:-}" ]]; then
    value="X-Auth-Token: ${MINIFLUX_API_KEY}"
    value="${value//\\/\\\\}"; value="${value//\"/\\\"}"
    printf 'header = "%s"\n' "$value"
  elif [[ -n "${ADMIN_PASSWORD:-}" ]]; then
    value="${ADMIN_USERNAME:-admin}:${ADMIN_PASSWORD}"
    value="${value//\\/\\\\}"; value="${value//\"/\\\"}"
    printf 'user = "%s"\n' "$value"
  else
    return 1
  fi
}
