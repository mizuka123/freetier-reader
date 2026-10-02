#!/usr/bin/env bash
# Miniflux にテーマ（カスタム CSS）を適用する。
#   ./scripts/apply-theme.sh           .env の MINIFLUX_THEME を適用（dads: 適用 / none: 何もしない）
#   ./scripts/apply-theme.sh --reset   dads を初めて適用する前の設定に戻す
# 認証: MINIFLUX_API_KEY（推奨。Miniflux の設定 → API キー）があればそれを、なければ ADMIN_USERNAME / ADMIN_PASSWORD を使う。
#       認証情報はプロセス一覧に出ないよう curl の設定ファイル（プロセス置換）で渡す。
# Miniflux の API に VM のローカルホスト（MINIFLUX_LOCAL_PORT）から接続する。python3 が必要。
# 失敗すると .state/theme.failed を作り、scripts/monitor.sh が通知する。
set -Eeuo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib.sh
source scripts/lib.sh

state_dir=".state"
failed_marker="${state_dir}/theme.failed"
backup_file="${state_dir}/theme-before-dads.json"
mkdir -p "$state_dir"

fail() {
  echo "error: $1" >&2
  echo "$(date -u +%FT%TZ) $1" > "$failed_marker"
  exit 1
}
trap 'fail "apply-theme failed at line $LINENO"' ERR

load_env
command -v python3 >/dev/null || fail "python3 が必要です"

mode="${MINIFLUX_THEME:-dads}"
[[ "${1:-}" == "--reset" ]] && mode=reset
base_url="http://127.0.0.1:${MINIFLUX_LOCAL_PORT:-8080}"

if [[ "$mode" == "none" ]]; then
  # 利用者が Miniflux の設定画面で管理しているテーマ・CSS には触れない
  rm -f "$failed_marker"
  echo "MINIFLUX_THEME=none: theme is managed in the Miniflux settings (no changes made)"
  exit 0
fi
[[ "$mode" == "dads" || "$mode" == "reset" ]] || fail "unknown MINIFLUX_THEME: ${mode} (dads / none)"

# curl の設定ファイル形式で認証情報を出力する（" と \ をエスケープ）
curl_auth_config() {
  local value
  if [[ -n "${MINIFLUX_API_KEY:-}" ]]; then
    value="X-Auth-Token: ${MINIFLUX_API_KEY}"
    value="${value//\\/\\\\}"; value="${value//\"/\\\"}"
    printf 'header = "%s"\n' "$value"
  else
    [[ -n "${ADMIN_PASSWORD:-}" ]] || fail "MINIFLUX_API_KEY または ADMIN_PASSWORD を設定してください"
    value="${ADMIN_USERNAME:-admin}:${ADMIN_PASSWORD}"
    value="${value//\\/\\\\}"; value="${value//\"/\\\"}"
    printf 'user = "%s"\n' "$value"
  fi
}

api() {
  curl -sS --fail-with-body -m 20 -K <(curl_auth_config) -H 'Content-Type: application/json' "$@"
}

me="$(api "${base_url}/v1/me")" \
  || fail "Miniflux API に接続できません（認証情報・起動状態を確認。管理者パスワードを変更した場合は MINIFLUX_API_KEY を設定）: ${me:-}"
user_id="$(python3 -c 'import json, sys; print(json.loads(sys.argv[1])["id"])' "$me")"

# 送信する JSON を作る（CSS はファイルから直接読む）
payload="$(MODE="$mode" WEB_FONT="${MINIFLUX_THEME_WEB_FONT:-false}" BACKUP="$backup_file" ME="$me" python3 - <<'PY'
import json, os

mode = os.environ["MODE"]
me = json.loads(os.environ["ME"])
backup_path = os.environ["BACKUP"]

if mode == "reset":
    if os.path.exists(backup_path):
        before = json.load(open(backup_path, encoding="utf-8"))
    else:
        before = {"stylesheet": "", "theme": "light_serif", "external_font_hosts": ""}
    body = {"stylesheet": before["stylesheet"], "theme": before["theme"]}
    # Miniflux は空の external_font_hosts を受け付けないため、空なら送らない（設定は残る）
    if before.get("external_font_hosts"):
        body["external_font_hosts"] = before["external_font_hosts"]
else:
    # 初めて dads を適用するときだけ、元の設定を保存しておく（--reset で戻すため）
    if not os.path.exists(backup_path) and "--dads-" not in me.get("stylesheet", ""):
        with open(backup_path, "w", encoding="utf-8") as f:
            json.dump({k: me.get(k, "") for k in ("stylesheet", "theme", "external_font_hosts")}, f, ensure_ascii=False)
    css = open("themes/dads/miniflux.css", encoding="utf-8").read()
    body = {"theme": "system_sans_serif"}
    if os.environ["WEB_FONT"] == "true":
        # Noto Sans JP を Google Fonts から読み込む（閲覧端末から Google へのリクエストが発生する）
        css = '@import url("https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;700&display=swap");\n' + css
        body["external_font_hosts"] = "fonts.googleapis.com fonts.gstatic.com"
    body["stylesheet"] = css

print(json.dumps(body))
PY
)"

result="$(api -X PUT --data-binary @- "${base_url}/v1/users/${user_id}" <<<"$payload")" \
  || fail "Miniflux がテーマ設定を受け付けませんでした: ${result:-}"

if [[ "$mode" == "reset" ]]; then
  rm -f "$backup_file"
  echo "theme reset to the settings before dads was applied"
else
  echo "applied theme: dads (web font: ${MINIFLUX_THEME_WEB_FONT:-false})"
fi
rm -f "$failed_marker"
