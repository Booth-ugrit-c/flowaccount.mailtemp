#!/usr/bin/env bash
# ACT-14: Email Routing rules via API. Flag --catch-all sets catch-all -> capture-worker.
# API: https://developers.cloudflare.com/api/resources/email_routing/subresources/rules/methods/create/
# API: https://developers.cloudflare.com/api/resources/email_routing/subresources/rules/subresources/catch_alls/methods/update/
# API: https://developers.cloudflare.com/api/resources/email_routing/methods/get/
source "$(dirname "$0")/cf-env.sh" || exit 1
[ "${CF_ENV_READY:-}" = 1 ] || exit 1
set -u
ZONE_NAME="${ZONE_NAME:-booth.pp.ua}"; API=https://api.cloudflare.com/client/v4
CATCH=0; [ "${1:-}" = "--catch-all" ] && CATCH=1
OUT="$POC_DIR/evidence/p3/ACT-14-routing.md"; mkdir -p "$(dirname "$OUT")"
exec > >(tee "$OUT") 2>&1
WORKER="$(sed -n 's/^name *= *"\(.*\)"/\1/p' "$POC_DIR/worker/wrangler.toml" | head -1)"
H13="$(sed -n 's/^name *= *"\(.*\)"/\1/p' "$POC_DIR/probe-h13/wrangler.toml" | head -1)"
cf() { curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" "$@"; }
# js '<statements using j>' [args]: parse stdin JSON into j
js() { local code="$1"; shift; node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);'"$code"'})' "$@"; }
ZR="$(cf "$API/zones?name=$ZONE_NAME")"
ZONE="$(printf '%s' "$ZR" | js 'const z=(j.result||[])[0];if(z)console.log(z.id+" "+z.account.id+" "+z.status)')"
[ -n "$ZONE" ] || { echo "ERROR: zone $ZONE_NAME not found for this token"; exit 1; }
set -- $ZONE; ZID=$1; ZACC=$2; echo "zone $ZONE_NAME id=$ZID status=$3"
[ "$ZACC" = "$CLOUDFLARE_ACCOUNT_ID" ] || { echo "ERROR: zone account $ZACC != confirmed account"; exit 1; }
echo "## settings"
cf "$API/zones/$ZID/email/routing" | js 'const r=j.result||{};console.log(JSON.stringify({success:j.success,enabled:r.enabled,status:r.status,support_subaddress:r.support_subaddress,keys:Object.keys(r)}))'
RULES="$(cf "$API/zones/$ZID/email/routing/rules?per_page=50")"
ensure() {
  local addr="$1" wk="$2" body
  if printf '%s' "$RULES" | js 'const a=process.argv[1],w=process.argv[2];const ok=(j.result||[]).some(r=>r.matchers.some(m=>m.value===a)&&r.actions.some(x=>x.type==="worker"&&(x.value||[])[0]===w));process.exit(ok?0:1)' "$addr" "$wk"; then echo "exists: $addr -> $wk"; return; fi
  body="{\"name\":\"poc $addr\",\"enabled\":true,\"matchers\":[{\"type\":\"literal\",\"field\":\"to\",\"value\":\"$addr\"}],\"actions\":[{\"type\":\"worker\",\"value\":[\"$wk\"]}]}"
  cf -X POST "$API/zones/$ZID/email/routing/rules" -d "$body" | js 'console.log("create "+process.argv[1]+": success="+j.success+" "+JSON.stringify(j.errors||[]))' "$addr"
}
ensure "qa@$ZONE_NAME" "$WORKER"
for h in h13-return h13-throw h13-cpu h13-reject; do ensure "$h@$ZONE_NAME" "$H13"; done
if [ $CATCH = 1 ]; then
  cf -X PUT "$API/zones/$ZID/email/routing/rules/catch_all" -d "{\"name\":\"poc catch-all\",\"enabled\":true,\"matchers\":[{\"type\":\"all\"}],\"actions\":[{\"type\":\"worker\",\"value\":[\"$WORKER\"]}]}" | js 'console.log("catch-all: success="+j.success+" "+JSON.stringify(j.errors||[]))'
fi
echo "## rules"
FINAL="$(cf "$API/zones/$ZID/email/routing/rules?per_page=50")"
printf '%s' "$FINAL" | js 'for(const r of j.result||[])console.log(r.matchers.map(m=>m.value||m.type).join(",").padEnd(34),r.actions.map(a=>a.type+":"+(a.value||[]).join("")).join(","),r.enabled)'
echo "## catch-all"
CA="$(cf "$API/zones/$ZID/email/routing/rules/catch_all")"
printf '%s' "$CA" | js 'const r=j.result||{};console.log("enabled="+r.enabled,(r.actions||[]).map(a=>a.type+":"+(a.value||[]).join("")).join(","))'
if printf '%s\n%s' "$FINAL" "$CA" | grep -q '"type": *"forward"'; then echo "FAIL RULE-01: forward action present"; exit 1; fi
echo "RULE-01 check ok: no forward actions"
