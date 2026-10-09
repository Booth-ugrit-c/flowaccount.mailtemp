#!/usr/bin/env bash
# Runs only in the isolated compose project "janitorcheck" (own volumes, port 28025); never against the live stack.
set -u
cd "$(dirname "$0")/../.."

PROJECT=janitorcheck
export MAILPIT_HOST_PORT=28025 BRIDGE_HOST_PORT=28080 INBOX_HOST_PORT=28090 JANITOR_IMAGE=janitorcheck-janitor
[ "$PROJECT" != "capture-poc" ] && [ "$MAILPIT_HOST_PORT" != "8025" ] || { echo "refusing to run against the live stack"; exit 1; }
DC="docker compose -p $PROJECT"
MP="http://127.0.0.1:$MAILPIT_HOST_PORT/admin/api/v1"
QUOTA=200000
FAILS=0

envv() { grep -m1 "^$1=" .env | cut -d= -f2- | tr -d '[:cntrl:]'; }
AUTH="$(envv MAILPIT_UI_USER):$(envv MAILPIT_UI_PASSWORD)"
mp() { curl -s -u "$AUTH" "$@"; }

pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1  ($2)"; FAILS=$((FAILS + 1)); }
expect() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "expected $3, got $2"; fi; }
check() { if [ "$2" = "1" ] || [ "$2" = "true" ]; then pass "$1"; else fail "$1" "${3:-condition false}"; fi; }

cleanup() {
  $DC down -v > /dev/null 2>&1
  docker rmi "$JANITOR_IMAGE" > /dev/null 2>&1
  echo "cleanup: project $PROJECT removed with its volumes"
  echo "result: $FAILS failure(s)"
  [ "$FAILS" = "0" ] || exit 1
}
trap cleanup EXIT

api_sum() { mp "$MP/messages?limit=100000" | jq '[.messages[].Size] | add // 0'; }
api_count() { mp "$MP/messages?limit=1" | jq .total; }
api_seqs() { mp "$MP/messages?limit=100000" | jq -r '.messages[].Subject' | sed -n 's/^janitor-A-//p' | sort -n | tr '\n' ' '; }
seed() { MSYS_NO_PATHCONV=1 $DC run --rm -T -v "$(cygpath -m "$PWD")/janitor/test:/test:ro" --entrypoint node janitor /test/seed.mjs "$@" 2>&1 | tail -1; }
cycles() { $DC logs --no-log-prefix janitor 2>/dev/null | grep '^{' | jq -c 'select(.event == "cycle")'; }
wait_cycle() {
  for _ in $(seq 1 40); do
    line=$(cycles | jq -c "select($1)" | head -1)
    [ -n "$line" ] && { echo "$line"; return 0; }
    sleep 1
  done
  return 1
}
once() { $DC run --rm -T "$@" janitor 2>/dev/null | grep '^{' | jq -c 'select(.event == "cycle")' | tail -1; }
daemon() { env "$@" $DC up -d --force-recreate janitor > /dev/null 2>&1; }

echo "== start isolated project"
$DC up -d --build mailpit janitor > /dev/null 2>&1
$DC stop janitor > /dev/null 2>&1
for _ in $(seq 1 40); do [ "$(docker inspect -f '{{.State.Health.Status}}' ${PROJECT}-mailpit-1 2>/dev/null)" = "healthy" ] && break; sleep 2; done
expect "isolated mailpit is healthy" "$(docker inspect -f '{{.State.Health.Status}}' ${PROJECT}-mailpit-1)" healthy
expect "isolated mailbox starts empty" "$(api_count)" 0
MAX_MESSAGES_ENV=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' ${PROJECT}-mailpit-1 | grep -c '^MP_MAX_MESSAGES=0$')
AGE_ENV=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' ${PROJECT}-mailpit-1 | grep -c '^MP_MAX_AGE=')
expect "mailpit runs with MP_MAX_MESSAGES=0 (no count cap)" "$MAX_MESSAGES_ENV" 1
expect "mailpit has no MP_MAX_AGE" "$AGE_ENV" 0

echo "== long-running janitor, quota $QUOTA bytes, 2 s cycles"
daemon MAIL_QUOTA_BYTES=$QUOTA INTERVAL_SECONDS=2
first=$(wait_cycle '.count == 0')
check "first cycle: full scan of the empty mailbox deletes nothing" "$(echo "$first" | jq '.rescan == "start" and .deleted == 0 and .usage == 0')" "$first"

seed 5 20000 A 1 5 > /dev/null
below=$(wait_cycle '.count == 5')
check "below the high watermark: nothing deleted" "$(echo "$below" | jq '.deleted == 0 and .pct < 90 and .pct > 40')" "$below"
check "below the high watermark: new mail found by the incremental scan" "$(echo "$below" | jq '.rescan == "none"')" "$below"
expect "no cycle so far deleted anything" "$(cycles | jq -s '[.[] | select(.deleted > 0)] | length')" 0

seed 10 20000 A 6 5 > /dev/null
purge=$(wait_cycle '.deleted > 0')
check "above the high watermark: a purge happened" "$([ -n "$purge" ] && echo 1)" "no purge line"
check "purge ends at or below the low watermark" "$(echo "$purge" | jq --argjson q $QUOTA '.usageAfter <= ($q * 70 / 100)')" "$purge"
sleep 6
SEQS=$(api_seqs)
FIRST_SEQ=$(echo $SEQS | cut -d' ' -f1)
LAST_SEQ=$(echo $SEQS | awk '{print $NF}')
COUNT_NOW=$(echo $SEQS | wc -w | tr -d ' ')
check "newest message is kept" "$([ "$LAST_SEQ" = "15" ] && echo 1)" "last=$LAST_SEQ"
check "survivors are one unbroken run of the newest messages (oldest deleted first)" "$([ "$((LAST_SEQ - FIRST_SEQ + 1))" = "$COUNT_NOW" ] && [ "$FIRST_SEQ" -gt 1 ] && echo 1)" "seqs: $SEQS"
SUM_NOW=$(api_sum)
check "mailbox is below the high watermark after the purge" "$([ "$SUM_NOW" -lt "$((QUOTA * 90 / 100))" ] && echo 1)" "sum=$SUM_NOW"

purge_log_n=$(cycles | wc -l)
sleep 8
after=$(cycles | tail -n +$((purge_log_n + 1)))
check "no spiral: the cycles right after a purge delete nothing" "$(echo "$after" | jq -s 'length >= 3 and all(.[]; .deleted == 0)')" "$after"
expect "no spiral: the mailbox count did not change" "$(api_count)" "$COUNT_NOW"
echo "INFO  fileBytes at purge: $(echo "$purge" | jq .fileBytes); later: $(echo "$after" | tail -1 | jq .fileBytes) (SQLite keeps the file size; the janitor does not measure it)"

echo "== external delete triggers a rescan"
VICTIM=$(mp "$MP/messages?limit=100000" | jq -r '.messages[1].ID')
mp -X DELETE -H 'Content-Type: application/json' -d "{\"IDs\":[\"$VICTIM\"]}" "$MP/messages" > /dev/null
rescan=$(wait_cycle '.rescan == "mismatch"')
check "an external delete is noticed (rescan: mismatch)" "$([ -n "$rescan" ] && echo 1)" "no mismatch line"
sleep 3
API_SUM=$(api_sum); API_COUNT=$(api_count)
check "after the rescan the janitor's sum equals the API sum" "$(echo "$rescan" | jq --argjson s "$API_SUM" --argjson c "$API_COUNT" '.usage == $s and .count == $c')" "janitor: $rescan; api sum=$API_SUM count=$API_COUNT"
check "the next cycle is incremental again" "$(cycles | tail -1 | jq '.rescan == "none" and .deleted == 0')"

echo "== periodic rescan"
daemon MAIL_QUOTA_BYTES=$QUOTA INTERVAL_SECONDS=2 RESCAN_HOURS=0.0006
periodic=$(wait_cycle '.rescan == "periodic"')
check "the periodic safety rescan fires" "$([ -n "$periodic" ] && echo 1)" "no periodic line"
$DC stop janitor > /dev/null 2>&1

echo "== DRY_RUN"
seed 10 20000 A 16 0 > /dev/null
BEFORE_COUNT=$(api_count)
dry=$(once -e RUN_ONCE=1 -e DRY_RUN=1 -e MAIL_QUOTA_BYTES=$QUOTA)
check "DRY_RUN reports what it would delete and deletes nothing" "$(echo "$dry" | jq '.wouldDelete > 0 and .deleted == 0')" "$dry"
expect "DRY_RUN leaves the mailbox untouched" "$(api_count)" "$BEFORE_COUNT"
real=$(once -e RUN_ONCE=1 -e MAIL_QUOTA_BYTES=$QUOTA)
check "the same mailbox without DRY_RUN deletes exactly the reported number" "$(jq -n --argjson d "$dry" --argjson r "$real" '$r.deleted == $d.wouldDelete')" "dry=$dry real=$real"

echo "== configuration guard"
$DC run --rm -T -e RUN_ONCE=1 -e LOW_WATERMARK_PCT=95 janitor > /dev/null 2>&1
GUARD_RC=$?
check "low watermark above high watermark is rejected" "$([ "$GUARD_RC" -ne 0 ] && echo 1)" "exit $GUARD_RC"

echo "== full-scan timing (isolated project only)"
mp -X DELETE "$MP/messages" > /dev/null
seed 10000 1000 T 1 0 > /dev/null
t1=$(once -e RUN_ONCE=1)
check "full scan of 10000 messages: count correct, nothing deleted" "$(echo "$t1" | jq '.count == 10000 and .deleted == 0 and .rescan == "start"')" "$t1"
echo "INFO  full scan of 10000 messages: $(echo "$t1" | jq .ms) ms"
seed 10000 1000 U 1 0 > /dev/null
t2=$(once -e RUN_ONCE=1)
check "full scan of 20000 messages: count correct, nothing deleted" "$(echo "$t2" | jq '.count == 20000 and .deleted == 0')" "$t2"
echo "INFO  full scan of 20000 messages: $(echo "$t2" | jq .ms) ms"
