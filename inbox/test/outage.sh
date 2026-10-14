#!/usr/bin/env bash
# Stops and starts services of the isolated compose project "outagecheck" only; never touches the live stack.
set -u
cd "$(dirname "$0")/../.."

PROJECT=outagecheck
export MAILPIT_HOST_PORT=38025 BRIDGE_HOST_PORT=38080 INBOX_HOST_PORT=38090 BRIDGE_IMAGE=outagecheck-bridge INBOX_IMAGE=outagecheck-inbox
[ "$PROJECT" != "capture-poc" ] && [ "$INBOX_HOST_PORT" != "8090" ] || { echo "refusing to run against the live stack"; exit 1; }
DC="docker compose -p $PROJECT"
FAILS=0

cleanup() {
  $DC down -v > /dev/null 2>&1
  docker rmi "$BRIDGE_IMAGE" "$INBOX_IMAGE" > /dev/null 2>&1
  echo "cleanup: project $PROJECT removed with its volumes"
  echo "result: $FAILS failure(s)"
  [ "$FAILS" = "0" ] || exit 1
}
trap cleanup EXIT

[ -f .env ] && [ -f secrets/ui_auth ] && [ -f secrets/inbox.env ] || { echo "run bash setup.sh first"; exit 1; }

$DC up -d --build mailpit bridge inbox > /dev/null 2>&1
ready=no
for _ in $(seq 1 60); do
  status=$(curl -s -m 3 "http://127.0.0.1:$INBOX_HOST_PORT/api/status" | jq -c '[.mailpit, .bridge]' 2>/dev/null)
  [ "$status" = '["ok","ok"]' ] && { ready=yes; break; }
  sleep 2
done
[ "$ready" = "yes" ] && echo "PASS  isolated stack reports mailpit and bridge ok" || { echo "FAIL  isolated stack did not become healthy"; FAILS=$((FAILS + 1)); exit 1; }

SHOT=""
[ -n "${SHOT_DIR:-}" ] && SHOT="$SHOT_DIR"
OUT=$(mktemp)
OUTAGE_PROJECT=$PROJECT INBOX_URL="http://127.0.0.1:$INBOX_HOST_PORT" node inbox/test/outage.mjs $SHOT | tee "$OUT"
RC=${PIPESTATUS[0]}
FAILS=$((FAILS + $(grep -c '^FAIL' "$OUT")))
[ "$RC" = "0" ] || { echo "FAIL  outage.mjs exited $RC"; FAILS=$((FAILS + 1)); }
rm -f "$OUT"
