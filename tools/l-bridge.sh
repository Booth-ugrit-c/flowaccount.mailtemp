#!/usr/bin/env bash
# L-01..L-06 against the running compose stack. Run from poc/.
set -u
R=$(date +%s)
. ./.env
MPAUTH="$MAILPIT_UI_USER:$MAILPIT_UI_PASSWORD"
W=tools/work
api(){ curl -s -u "$MPAUTH" "http://127.0.0.1:8025/admin$1"; }
count(){ api "/api/v1/search?query=$1" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('search $1 -> messages_count='+j.messages_count)})"; }
firstid(){ api "/api/v1/search?query=$1" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).messages[0].ID))"; }
api_del(){ curl -s -u "$MPAUTH" -X DELETE http://127.0.0.1:8025/admin/api/v1/messages; echo; }
api_del
case "${1:-all}" in all|l01)
echo "=== L-01"; node tools/make-eml.mjs $W/l01.eml qa+t-l01@poc.test 0 l01@poc.test
node tools/ingest.mjs $W/l01.eml cap-$R-l01 qa+t-l01@poc.test
api /api/v1/message/$(firstid tag:t-l01)/raw > $W/l01.stored
node tools/strip-prepended.mjs $W/l01.stored $W/l01.eml;; esac
echo "=== L-02"; node tools/make-eml.mjs $W/l02.eml qa+t-l02@poc.test 0 l02@poc.test >/dev/null
node tools/make-eml.mjs $W/l02b.eml qa+t-other@poc.test 0 l02b@poc.test >/dev/null
node tools/ingest.mjs $W/l02.eml cap-$R-l02 qa+t-l02@poc.test; node tools/ingest.mjs $W/l02b.eml cap-$R-l02b qa+t-other@poc.test
count tag:t-l02; count tag:t-other
echo "=== L-03"; node tools/make-eml.mjs $W/l03-25.eml qa+t-l03@poc.test 26214400 l03@poc.test
node tools/make-eml.mjs $W/l03-27.eml qa+t-l03x@poc.test 28311552 l03x@poc.test
node tools/ingest.mjs $W/l03-25.eml cap-$R-l03 qa+t-l03@poc.test
api /api/v1/message/$(firstid tag:t-l03)/raw > $W/l03.stored
node tools/strip-prepended.mjs $W/l03.stored $W/l03-25.eml
node tools/ingest.mjs $W/l03-27.eml cap-$R-l03x qa+t-l03x@poc.test
count tag:t-l03x
echo "=== L-04"; node tools/make-eml.mjs $W/l04.eml qa+t-l04@poc.test 0 l04@poc.test >/dev/null
for m in nosig skew tamper valid; do MODE=$m node tools/ingest.mjs $W/l04.eml cap-$R-l04-$m qa+t-l04@poc.test; done
count tag:t-l04
echo "=== L-05"; node tools/make-eml.mjs $W/l05.eml qa+t-l05@poc.test 0 l05@poc.test >/dev/null
node tools/ingest.mjs $W/l05.eml cap-$R-l05 qa+t-l05@poc.test; node tools/ingest.mjs $W/l05.eml cap-$R-l05 qa+t-l05@poc.test; count tag:t-l05
docker compose restart bridge 2>&1 | tail -1; sleep 3
node tools/ingest.mjs $W/l05.eml cap-$R-l05 qa+t-l05@poc.test; count tag:t-l05
docker logs capture-poc-bridge-1 2>&1 | grep "cap-$R-l05"
echo "=== L-06"; node tools/make-eml.mjs $W/l06.eml qa+t-l06@poc.test 0 l06@poc.test >/dev/null
node tools/ingest.mjs $W/l06.eml cap-$R-l06 "qa+t-l06@poc.test,bcc-only@poc.test"
count to:bcc-only@poc.test
count bcc:bcc-only@poc.test
api /api/v1/message/$(firstid bcc:bcc-only@poc.test) | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('To='+JSON.stringify(j.To.map(a=>a.Address))+' Bcc='+JSON.stringify(j.Bcc.map(a=>a.Address)))})"
