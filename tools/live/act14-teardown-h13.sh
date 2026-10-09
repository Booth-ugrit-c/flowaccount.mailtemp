#!/usr/bin/env bash
# Delete h13-* rules first, then the capture-h13 Worker.
# API: https://developers.cloudflare.com/api/resources/email_routing/subresources/rules/methods/delete/
source "$(dirname "$0")/cf-env.sh" || exit 1
[ "${CF_ENV_READY:-}" = 1 ] || exit 1
set -u
ZONE_NAME="${ZONE_NAME:-booth.pp.ua}"; API=https://api.cloudflare.com/client/v4
cf() { curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" "$@"; }
js() { local code="$1"; shift; node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);'"$code"'})' "$@"; }
H13="$(sed -n 's/^name *= *"\(.*\)"/\1/p' "$POC_DIR/probe-h13/wrangler.toml" | head -1)"
ZID="$(cf "$API/zones?name=$ZONE_NAME" | js 'const z=(j.result||[])[0];if(z&&z.account.id===process.env.CLOUDFLARE_ACCOUNT_ID)console.log(z.id)')"
[ -n "$ZID" ] || { echo "ERROR: zone not found in confirmed account"; exit 1; }
for id in $(cf "$API/zones/$ZID/email/routing/rules?per_page=50" | js 'for(const r of j.result||[])if(r.matchers.some(m=>/^h13-/.test(m.value||"")))console.log(r.id)'); do
  cf -X DELETE "$API/zones/$ZID/email/routing/rules/$id" | js 'console.log("delete rule "+process.argv[1]+": success="+j.success)' "$id"
done
(cd "$POC_DIR/probe-h13" && npx wrangler delete --name "$H13" --force)
echo "## remaining rules"
cf "$API/zones/$ZID/email/routing/rules?per_page=50" | js 'for(const r of j.result||[])console.log(r.matchers.map(m=>m.value||m.type).join(","))'
