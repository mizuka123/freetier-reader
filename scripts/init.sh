#!/usr/bin/env bash
# .env.example から .env を作成し、CHANGE_ME の秘密値をランダム生成する。
# 既に .env がある場合は CHANGE_ME のまま残っている値と、行のない秘密値だけを埋める（既存値は上書きしない）。
# 手で設定すべき値が CHANGE_ME のまま残っていれば終了コード 2 を返す。
set -euo pipefail

cd "$(dirname "$0")/.."

command -v openssl >/dev/null || { echo "error: openssl が必要です" >&2; exit 1; }

if [[ ! -f .env ]]; then
  cp .env.example .env
  chmod 600 .env
  echo "created .env from .env.example"
fi

# Windows で編集して改行が CRLF になった .env は、値の末尾に \r が付いて正しく読めないため止める
if [[ -n "$(tr -dc '\r' < .env)" ]]; then
  echo "error: .env の改行が CRLF です。LF に変換してください（例: sed -i 's/\r$//' .env）" >&2
  exit 1
fi

gen() {
  local len="$1" value
  value="$(openssl rand -base64 96 | tr -dc 'A-Za-z0-9' | head -c "$len")"
  if [[ ${#value} -ne $len ]]; then
    echo "error: 秘密値の生成に失敗しました" >&2
    exit 1
  fi
  printf '%s' "$value"
}

fill() {
  local key="$1" len="$2" value
  if grep -qE "^${key}=(CHANGE_ME)?$" .env; then
    # CHANGE_ME のまま、または値が空
    value="$(gen "$len")"
    sed -i.bak -E "s|^${key}=(CHANGE_ME)?$|${key}=${value}|" .env
    rm -f .env.bak
    echo "generated ${key}"
  elif ! grep -qE "^${key}=" .env; then
    # 後から追加された秘密値（既存の .env にはまだ行がない）
    value="$(gen "$len")"
    printf '\n%s=%s\n' "$key" "$value" >> .env
    echo "added ${key}"
  fi
}

fill ADMIN_PASSWORD 24
fill POSTGRES_PASSWORD 32
fill X_WEBHOOK_TOKEN 48
fill MEDIA_PROXY_PRIVATE_KEY 48

if grep -q '=CHANGE_ME$' .env; then
  echo
  echo "次の値はまだ CHANGE_ME です。.env を編集して設定してください:" >&2
  grep -E '=CHANGE_ME$' .env | cut -d= -f1 >&2
  exit 2
fi
echo ".env is ready"
