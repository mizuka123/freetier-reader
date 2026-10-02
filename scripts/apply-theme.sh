#!/usr/bin/env bash
# Miniflux にテーマ（カスタム CSS）を適用する。
#   ./scripts/apply-theme.sh           .env の MINIFLUX_THEME（既定: dads）を適用
#   ./scripts/apply-theme.sh --reset   カスタム CSS を外し Miniflux 標準のテーマに戻す
# 認証: MINIFLUX_API_KEY（推奨。Miniflux の設定 → API キー）があればそれを、なければ ADMIN_USERNAME / ADMIN_PASSWORD を使う。
# Miniflux の API に VM のローカルホスト（MINIFLUX_LOCAL_PORT）から接続する。python3 が必要。
set -Eeuo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib.sh
source scripts/lib.sh
load_env

command -v python3 >/dev/null || { echo "error: python3 が必要です" >&2; exit 1; }

theme="${MINIFLUX_THEME:-dads}"
[[ "${1:-}" == "--reset" ]] && theme=none
base_url="http://127.0.0.1:${MINIFLUX_LOCAL_PORT:-8080}"

auth=()
if [[ -n "${MINIFLUX_API_KEY:-}" ]]; then
  auth=(-H "X-Auth-Token: ${MINIFLUX_API_KEY}")
else
  auth=(-u "${ADMIN_USERNAME:-admin}:${ADMIN_PASSWORD:?set MINIFLUX_API_KEY or ADMIN_PASSWORD}")
fi

api() {
  curl -fsS -m 20 "${auth[@]}" -H 'Content-Type: application/json' "$@"
}

user_id="$(api "${base_url}/v1/me" | python3 -c 'import json, sys; print(json.load(sys.stdin)["id"])')" \
  || { echo "error: Miniflux API に接続できません（認証情報・起動状態を確認。管理者パスワードを変更した場合は MINIFLUX_API_KEY を設定）" >&2; exit 1; }

case "$theme" in
  none)
    stylesheet=""
    miniflux_theme="light_serif"
    font_hosts=""
    ;;
  dads)
    css_file="themes/dads/miniflux.css"
    [[ -f "$css_file" ]] || { echo "error: $css_file not found" >&2; exit 1; }
    miniflux_theme="system_sans_serif"
    font_hosts=""
    stylesheet="$(cat "$css_file")"
    if [[ "${MINIFLUX_THEME_WEB_FONT:-false}" == "true" ]]; then
      # Noto Sans JP を Google Fonts から読み込む（閲覧端末から Google へのリクエストが発生する）
      stylesheet="@import url(\"https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;700&display=swap\");
${stylesheet}"
      font_hosts="https://fonts.googleapis.com https://fonts.gstatic.com"
    fi
    ;;
  *)
    echo "error: unknown MINIFLUX_THEME: $theme (dads / none)" >&2
    exit 1
    ;;
esac

payload="$(STYLESHEET="$stylesheet" THEME="$miniflux_theme" FONT_HOSTS="$font_hosts" python3 -c '
import json, os
print(json.dumps({
    "stylesheet": os.environ["STYLESHEET"],
    "theme": os.environ["THEME"],
    "external_font_hosts": os.environ["FONT_HOSTS"],
}))')"

api -X PUT --data-binary @- "${base_url}/v1/users/${user_id}" >/dev/null <<<"$payload"
echo "applied theme: ${theme} (Miniflux theme: ${miniflux_theme})"
