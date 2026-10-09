#!/usr/bin/env bash
# ACT-13: KV + secrets + deploy capture-worker and capture-h13. Idempotent.
source "$(dirname "$0")/cf-env.sh" || exit 1
[ "${CF_ENV_READY:-}" = 1 ] || exit 1
set -u
OUT="$POC_DIR/evidence/p3/ACT-13-deploy.md"; mkdir -p "$(dirname "$OUT")"
exec > >(tee "$OUT") 2>&1
echo "# ACT-13 deploy $(date -u +%FT%TZ) account=$CLOUDFLARE_ACCOUNT_ID"
cd "$POC_DIR/worker"
TOML=wrangler.toml
kvid() { npx wrangler kv namespace list 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{s=s.slice(s.indexOf("["), s.lastIndexOf("]")+1);try{const m=JSON.parse(s).find(n=>/(^|-)CAPTURE_FALLBACK$/.test(n.title));if(m)console.log(m.id)}catch(e){}})'; }
ID="$(kvid)"
if [ -z "$ID" ]; then npx wrangler kv namespace create CAPTURE_FALLBACK >/dev/null; ID="$(kvid)"; fi
[[ "$ID" =~ ^[0-9a-f]{32}$ ]] || { echo "ERROR: KV id not found" >&2; exit 1; }
echo "KV CAPTURE_FALLBACK id: $ID"
grep -q "id = \"$ID\"" $TOML || { cp $TOML "$TOML.bak"; sed -i "s/^id = \".*\"/id = \"$ID\"/" $TOML; echo "wrangler.toml KV id updated (backup: $TOML.bak)"; }
echo "WARN: BRIDGE_URL in $TOML is local-only; deployed worker falls back to KV until ACT-15 sets the tunnel URL"
put_secret() { printf '%s' "$2" | npx wrangler secret put "$1" >/dev/null && echo "secret set: $1"; }
HMAC="$(grep '^HMAC_KEY=' "$POC_DIR/.env" | cut -d= -f2- | tr -d '\r\n')"
if [ -n "$HMAC" ]; then put_secret HMAC_KEY "$HMAC"; else echo "SKIP: HMAC_KEY not in .env"; fi
for k in CF_ACCESS_CLIENT_ID CF_ACCESS_CLIENT_SECRET; do
  v="$(grep "^$k=" "$POC_DIR/.env" | cut -d= -f2- | tr -d '\r\n')"
  if [ -n "$v" ]; then put_secret "$k" "$v"; else echo "SKIP: $k not in .env (ACT-15)"; fi
done
unset HMAC v
for d in worker probe-h13; do
  echo "## deploy $d"; (cd "$POC_DIR/$d" && npx wrangler deploy 2>&1)
done
echo "## secrets capture-worker (names only)"; npx wrangler secret list --name capture-worker
echo "## versions"
for n in capture-worker capture-h13; do echo "$n:"; npx wrangler versions list --name "$n" 2>&1 | tail -8; done
