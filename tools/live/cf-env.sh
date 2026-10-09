# source me: own-account Cloudflare context. Never prints the token.
_live_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POC_DIR="$(cd "$_live_dir/../.." && pwd)"; export POC_DIR
source "$POC_DIR/tools/env.sh"
if [ ! -s "$POC_DIR/.cf-token" ]; then echo "ERROR: $POC_DIR/.cf-token missing or empty" >&2; return 1 2>/dev/null || exit 1; fi
CLOUDFLARE_API_TOKEN="$(tr -d '\r\n' < "$POC_DIR/.cf-token")"; export CLOUDFLARE_API_TOKEN
if [ -z "$CLOUDFLARE_API_TOKEN" ]; then echo "ERROR: empty token" >&2; return 1 2>/dev/null || exit 1; fi
_who="$(cd "$POC_DIR/worker" && npx wrangler whoami --json 2>/dev/null)"
CF_ACCOUNTS="$(printf '%s' "$_who" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);for(const a of (j.accounts||[]))console.log(a.id+"  "+a.name)}catch(e){}})')"
unset _who
if [ -z "$CF_ACCOUNTS" ]; then echo "ERROR: whoami returned no accounts (token invalid?)" >&2; unset CLOUDFLARE_API_TOKEN; return 1 2>/dev/null || exit 1; fi
echo "Accounts visible to this token (id  name):"; echo "$CF_ACCOUNTS"
if [ -z "${CONFIRM_ACCOUNT_ID:-}" ] || ! printf '%s\n' "$CF_ACCOUNTS" | grep -q "^${CONFIRM_ACCOUNT_ID}  "; then
  echo "BLOCKED: set CONFIRM_ACCOUNT_ID=<id of YOUR account> (must be one of the ids above), then run again." >&2
  unset CLOUDFLARE_API_TOKEN; return 1 2>/dev/null || exit 1
fi
export CLOUDFLARE_ACCOUNT_ID="$CONFIRM_ACCOUNT_ID" CF_ENV_READY=1
echo "OK: account $CLOUDFLARE_ACCOUNT_ID confirmed"
