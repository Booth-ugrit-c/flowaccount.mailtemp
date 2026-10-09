#!/usr/bin/env bash
# L-07..L-12 against wrangler dev (local). Run from poc/ with the compose stack up.
set -u
. tools/env.sh; set -a; . ./.env; set +a
export MAILPIT_USER=$MAILPIT_UI_USER MAILPIT_PASSWORD=$MAILPIT_UI_PASSWORD
MPAUTH="$MAILPIT_UI_USER:$MAILPIT_UI_PASSWORD"
R=$(date +%s); W=tools/work
SEND="-s -X POST -H Content-Type:message/rfc822"
kvlist(){ (cd worker; npx wrangler kv key list --binding CAPTURE_FALLBACK --local --persist-to ../$W/$1 2>/dev/null); }
kvkeys(){ kvlist $1 | grep '"name"' | sed 's/.*: "\(.*\)".*/\1/'; }
kvget(){ (cd worker; npx wrangler kv key get "$2" --binding CAPTURE_FALLBACK --local --persist-to ../$W/$1 2>/dev/null); }
mp_total(){ curl -s -u "$MPAUTH" http://127.0.0.1:8025/admin/api/v1/messages | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).total))"; }
mkeml(){ node tools/make-eml.mjs $W/$1.eml $2 0 $1-$R@poc.test; }
curl -s -u "$MPAUTH" -X DELETE http://127.0.0.1:8025/admin/api/v1/messages >/dev/null

echo "=== L-07 bridge unreachable"; mkeml l07 qa+t-l07@poc.test
bash tools/dev.sh worker 8801 s$R-l07 --var BRIDGE_URL:http://127.0.0.1:9/ingest >/dev/null
curl $SEND -w " http=%{http_code}\n" "http://127.0.0.1:8801/cdn-cgi/local/email?from=qa-sender@example.com&to=qa%2Bt-l07@poc.test" --data-binary @$W/l07.eml
K=$(kvkeys s$R-l07); echo "kv keys: $K"; kvlist s$R-l07 | tr -d '\n ' ; echo
kvget s$R-l07 $K > $W/l07.stored; sha256sum $W/l07.eml $W/l07.stored | cut -c1-80
grep -a CAPTURE_ $W/dev-8801.log | cut -c1-200; bash tools/stop-dev.sh; sleep 2

echo "=== L-08 bridge 503"; mkeml l08 qa+t-l08@poc.test
(node tools/stub.mjs 503 9101 > $W/stub503.log 2>&1 &)
bash tools/dev.sh worker 8802 s$R-l08 --var BRIDGE_URL:http://127.0.0.1:9101/ingest >/dev/null
curl $SEND -w " http=%{http_code}\n" "http://127.0.0.1:8802/cdn-cgi/local/email?from=qa-sender@example.com&to=qa%2Bt-l08@poc.test" --data-binary @$W/l08.eml
cat $W/stub503.log; echo "kv keys: $(kvkeys s$R-l08)"; grep -a CAPTURE_ $W/dev-8802.log | cut -c1-200; bash tools/stop-dev.sh; sleep 2

echo "=== L-09 bridge hangs"; mkeml l09 qa+t-l09@poc.test
(node tools/stub.mjs hang 9102 > $W/stubhang.log 2>&1 &)
bash tools/dev.sh worker 8803 s$R-l09 --var BRIDGE_URL:http://127.0.0.1:9102/ingest >/dev/null
curl $SEND -w " http=%{http_code} elapsed=%{time_total}s (limit 17 s)\n" "http://127.0.0.1:8803/cdn-cgi/local/email?from=qa-sender@example.com&to=qa%2Bt-l09@poc.test" --data-binary @$W/l09.eml
cat $W/stubhang.log; echo "kv keys: $(kvkeys s$R-l09)"; grep -a CAPTURE_ $W/dev-8803.log | cut -c1-200; bash tools/stop-dev.sh; sleep 2

echo "=== L-10 replay cron"; for i in 1 2 3; do mkeml l10-$i qa+t-l10-$i@poc.test >/dev/null; done
bash tools/dev.sh worker 8804 s$R-l10 --test-scheduled --var BRIDGE_URL:http://127.0.0.1:9/ingest >/dev/null
for i in 1 2 3; do curl $SEND -o /dev/null -w "send $i http=%{http_code}\n" "http://127.0.0.1:8804/cdn-cgi/local/email?from=qa-sender@example.com&to=qa%2Bt-l10-$i@poc.test" --data-binary @$W/l10-$i.eml; done
KEYS=$(kvkeys s$R-l10); echo "kv entries before replay: $(echo "$KEYS" | wc -l)"
for k in $KEYS; do kvget s$R-l10 $k | sha256sum | cut -c1-16; done | sort | tr '\n' ' '; echo "(stored sha prefixes)"
bash tools/stop-dev.sh; sleep 2
bash tools/dev.sh worker 8805 s$R-l10 --test-scheduled --var BRIDGE_URL:http://127.0.0.1:8080/ingest >/dev/null
echo "mailpit total before: $(mp_total)"
curl -s -w " http=%{http_code}\n" "http://127.0.0.1:8805/__scheduled?cron=*%2F5+*+*+*+*"; sleep 2
echo "run 1: mailpit total=$(mp_total) kv entries=$(kvkeys s$R-l10 | grep -c .)"
for i in 1 2 3; do sha256sum $W/l10-$i.eml | cut -c1-16; done | sort | tr '\n' ' '; echo "(source sha prefixes)"
n=0; for k in $KEYS; do n=$((n+1)); (cd worker; npx wrangler kv key put "$k" --path ../$W/l10-$n.eml --metadata "{\"from\":\"qa-sender@example.com\",\"to\":\"qa+t-l10-$n@poc.test\",\"size\":$(wc -c < ../$W/l10-$n.eml)}" --binding CAPTURE_FALLBACK --local --persist-to ../$W/s$R-l10 >/dev/null 2>&1); done
echo "re-seeded same capture ids: kv entries=$(kvkeys s$R-l10 | grep -c .)"
curl -s -w " http=%{http_code}\n" "http://127.0.0.1:8805/__scheduled?cron=*%2F5+*+*+*+*"; sleep 2
echo "run 2: mailpit total=$(mp_total) kv entries=$(kvkeys s$R-l10 | grep -c .)"
docker logs capture-poc-bridge-1 2>&1 | grep -E "already_seen|delivered" | tail -6 | sed 's/"at":"[^"]*",//'
bash tools/stop-dev.sh; sleep 2

echo "=== L-11 KV put fails (metadata over 1024 bytes)"; mkeml l11 qa+t-l11@poc.test >/dev/null
LONG=$(printf 'a%.0s' $(seq 1 1100))
for mode in rethrow swallow; do port=$([ $mode = rethrow ] && echo 8806 || echo 8807)
bash tools/dev.sh worker $port s$R-l11-$mode --var BRIDGE_URL:http://127.0.0.1:9/ingest --var LAST_RESORT:$mode >/dev/null
echo "-- LAST_RESORT=$mode"; curl $SEND -o $W/l11-$mode.resp -w "http=%{http_code}\n" "http://127.0.0.1:$port/cdn-cgi/local/email?from=qa-sender@example.com&to=$LONG%40poc.test" --data-binary @$W/l11.eml; head -c 120 $W/l11-$mode.resp; echo
grep -a -E "CAPTURE_|Uncaught" $W/dev-$port.log | sed 's/aaaaaaaaaa*/a(1100)/g' | cut -c1-260
bash tools/stop-dev.sh; sleep 2; done

echo "=== L-12 worker -> bridge -> mailpit, Thai subject + PDF"; mkeml l12 qa+t-l12@poc.test >/dev/null
bash tools/dev.sh worker 8808 s$R-l12 --var BRIDGE_URL:http://127.0.0.1:8080/ingest >/dev/null
AFTER=$(date -u +%Y-%m-%dT%H:%M:%S.000Z); sleep 1
curl $SEND -w " http=%{http_code}\n" "http://127.0.0.1:8808/cdn-cgi/local/email?from=qa-sender@example.com&to=qa%2Bt-l12@poc.test" --data-binary @$W/l12.eml
grep -a CAPTURE_ $W/dev-8808.log | cut -c1-200
node --experimental-strip-types --disable-warning=ExperimentalWarning tools/l12-check.mts $W/l12.eml t-l12 $AFTER
bash tools/stop-dev.sh
pkill -f "stub.mjs" 2>/dev/null; true
