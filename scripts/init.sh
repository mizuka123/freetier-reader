#!/usr/bin/env bash
# .env.example から .env を作成し、CHANGE_ME の秘密値をランダム生成する。
# 既に .env がある場合は CHANGE_ME のまま残っている値だけを埋める（既存値は上書きしない）。
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  cp .env.example .env
  chmod 600 .env
  echo "created .env from .env.example"
fi

gen() { openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c "$1"; }

fill() {
  local key="$1" len="$2"
  if grep -qE "^${key}=CHANGE_ME$" .env; then
    sed -i.bak "s|^${key}=CHANGE_ME$|${key}=$(gen "$len")|" .env && rm -f .env.bak
    echo "generated ${key}"
  fi
}

fill ADMIN_PASSWORD 24
fill POSTGRES_PASSWORD 32
fill X_WEBHOOK_TOKEN 48

if grep -q 'CHANGE_ME' .env; then
  echo
  echo "次の値はまだ CHANGE_ME です。.env を編集して設定してください:"
  grep -n 'CHANGE_ME' .env | cut -d= -f1
fi
