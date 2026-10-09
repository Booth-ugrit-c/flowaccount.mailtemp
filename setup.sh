#!/usr/bin/env bash
# Creates the local secrets a fresh clone needs. Existing files are never touched.
set -eu
cd "$(dirname "$0")"

random_hex() { openssl rand -hex "$1"; }
read_env() { grep -m1 "^$1=" .env | cut -d= -f2- | tr -d '\r'; }
created=()

if [ -f .env ]; then
  echo "keep    .env (exists)"
else
  umask 077
  printf 'HMAC_KEY=%s\nMAILPIT_UI_USER=qa\nMAILPIT_UI_PASSWORD=%s\nTUNNEL_TOKEN=\n' "$(random_hex 32)" "$(random_hex 16)" > .env
  created+=(.env)
fi

mkdir -p secrets
QA_USER=$(read_env MAILPIT_UI_USER)
QA_PASSWORD=$(read_env MAILPIT_UI_PASSWORD)
[ -n "$QA_USER" ] && [ -n "$QA_PASSWORD" ] || { echo "error: .env needs MAILPIT_UI_USER and MAILPIT_UI_PASSWORD" >&2; exit 1; }

if [ -f secrets/ui_auth ]; then
  echo "keep    secrets/ui_auth (exists)"
else
  umask 077
  ADMIN_PASSWORD=${ADMIN_PASSWORD:-}
  GENERATED_ADMIN=no
  if [ -z "$ADMIN_PASSWORD" ]; then ADMIN_PASSWORD=$(random_hex 12); GENERATED_ADMIN=yes; fi
  printf '%s:%s\nroot:%s\n' "$QA_USER" "$QA_PASSWORD" "$ADMIN_PASSWORD" > secrets/ui_auth
  created+=(secrets/ui_auth)
fi

if [ -f secrets/inbox.env ]; then
  echo "keep    secrets/inbox.env (exists)"
else
  umask 077
  printf 'INBOX_KEY=%s\nMAILPIT_UI_USER=%s\nMAILPIT_UI_PASSWORD=%s\n' "$(random_hex 32)" "$QA_USER" "$QA_PASSWORD" > secrets/inbox.env
  created+=(secrets/inbox.env)
fi

if [ -f secrets/janitor.env ]; then
  echo "keep    secrets/janitor.env (exists)"
else
  umask 077
  printf 'MAILPIT_UI_USER=%s
MAILPIT_UI_PASSWORD=%s
' "$QA_USER" "$QA_PASSWORD" > secrets/janitor.env
  created+=(secrets/janitor.env)
fi

for file in "${created[@]+"${created[@]}"}"; do echo "created $file"; done
if [ "${GENERATED_ADMIN:-no}" = "yes" ]; then
  echo
  echo "Mailpit admin login (shown once): root / $ADMIN_PASSWORD"
  echo "Open http://127.0.0.1:8025/admin/ after 'docker compose up -d'."
fi
echo "next: docker compose up -d"
