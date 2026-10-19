# Runbook: set up on a real server

This runbook goes from an empty server and a fresh Cloudflare zone to a working inbox site. Verify every step before moving on. Decisions and the reasons behind them are in `docs/ADR.md`.

Placeholders, replace with yours everywhere:

| Placeholder | Example (replace) | Meaning |
|---|---|---|
| `<DOMAIN>` | `booth.pp.ua` | mail domain, its own apex zone on Cloudflare (ADR-007) |
| `<ACCOUNT_ID>` | 32 hex chars | Cloudflare account id |
| `<ZONE_ID>` | 32 hex chars | zone id of `<DOMAIN>` |
| `<TUNNEL_ID>` | UUID | tunnel id, created in step C5 |
| `$CF_TOKEN` | — | API token from step C1, exported in your shell, never committed |

## 0. Prerequisites

- A Linux server, or Windows/macOS with Docker Desktop. It needs Docker Engine with Compose v2, `git`, `bash`, `openssl`, `curl` and `jq`.
- Node.js 22+ and npm, for `wrangler`. They are needed only on the machine that deploys the Workers.
- A Cloudflare account (Free plan is enough) with `<DOMAIN>` on **Cloudflare DNS (full setup)**.
  - Use an apex zone. A subdomain has no catch-all (see section P).
  - Email Routing takes over the domain's MX, so do not use a domain that already receives real mail.

Check:
```bash
docker compose version && git --version && openssl version && jq --version && node --version
```

## H. Host side

### H1. Clone and create secrets
```bash
git clone https://github.com/<owner>/<repo>.git && cd <repo>
export ADMIN_PASSWORD='<choose-a-strong-password>'
bash setup.sh
```
Expected output: one `created …` line each for `.env`, `secrets/ui_auth`, `secrets/inbox.env`, `secrets/janitor.env` and `secrets/ci.env`, plus a one-time `ci / <password>` line, then `next: docker compose up -d`. If you do not set `ADMIN_PASSWORD`, a random one is printed **once**; save it. Re-running `setup.sh` never overwrites these files; the only change it makes to an existing file is appending the `ci:` line to `secrets/ui_auth` when it is missing.

### H2. Start the stack (without the tunnel)
```bash
docker compose up -d --build
docker compose ps
```
Expected: `mailpit` is `healthy`; `bridge`, `inbox` and `janitor` are `running`.

Verify:
```bash
curl -s http://127.0.0.1:8080/healthz                           # ok   (bridge)
curl -s http://127.0.0.1:8090/healthz                           # ok   (inbox)
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8025/admin/      # 401
curl -s -o /dev/null -w '%{http_code}\n' -u "root:$ADMIN_PASSWORD" http://127.0.0.1:8025/admin/   # 200
docker compose logs janitor --tail 1                            # {"event":"cycle",...,"deleted":0,...}
```

Keep `HMAC_KEY` from `.env` at hand; step C3 needs it:
```bash
grep '^HMAC_KEY=' .env | cut -d= -f2-
```

## C. Cloudflare side

### C1. API token
Create a **user API token**: My Profile → API Tokens → Create Token → Custom. Scope it to `<ACCOUNT_ID>` and the zone `<DOMAIN>`.

| Permission | Why | Source |
|---|---|---|
| Zone → Zone Settings: Edit | enable Email Routing, turn on subaddressing | Cloudflare API docs for `/email/routing` and `/email/routing/dns` ("Zone Settings Write") |
| Zone → Email Routing Rules: Edit | `qa@` rule and catch-all | API docs for rules ("Email Routing Rules Write") |
| Zone → DNS: Edit | tunnel CNAMEs | standard permission name; not exercised by token in this project |
| Zone → Workers Routes: Edit | `status-worker` routes | used in this project: the user token deployed the status Worker with both routes (`Deployed mailpit-status-fallback triggers`) |
| Account → Workers Scripts: Edit | deploy Workers, set secrets | used by `wrangler deploy` in this project |
| Account → Workers KV Storage: Edit | create the fallback KV namespace | used in this project |
| Account → Cloudflare Tunnel: Edit | create and configure the tunnel | standard permission name |
| Account → Account Analytics: Read | read the Email Routing activity log (GraphQL) | Cloudflare docs: "Your API token must include the Analytics Read permission" |

Verify:
```bash
export CF_TOKEN='<token>'
curl -s -H "Authorization: Bearer $CF_TOKEN" https://api.cloudflare.com/client/v4/user/tokens/verify | jq .result.status   # "active"
curl -s -H "Authorization: Bearer $CF_TOKEN" "https://api.cloudflare.com/client/v4/zones?name=<DOMAIN>" | jq -r '.result[0] | .id, .status'   # <ZONE_ID>, active
```
For `wrangler`, export the same token in that shell: `export CLOUDFLARE_API_TOKEN=$CF_TOKEN CLOUDFLARE_ACCOUNT_ID=<ACCOUNT_ID>`. Check that no other Cloudflare token is set in your environment, because wrangler uses whatever it finds.

### C2. Enable Email Routing and subaddressing
```bash
API=https://api.cloudflare.com/client/v4; Z=<ZONE_ID>; H=(-H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json")
curl -s -X POST "${H[@]}" $API/zones/$Z/email/routing/dns | jq '.success, .result.status'      # true, "ready"
curl -s -X PATCH "${H[@]}" $API/zones/$Z/email/routing -d '{"support_subaddress":true}' | jq .success
curl -s "${H[@]}" $API/zones/$Z/email/routing | jq '.result | {enabled, status, support_subaddress}'
```
Expected: `{"enabled": true, "status": "ready", "support_subaddress": true}`. Cloudflare adds and locks three MX records (`route1/2/3.mx.cloudflare.net`), an SPF TXT and a DKIM TXT.

Gotcha: do **not** send a body like `{"name":"<DOMAIN>"}` to `/email/routing/dns` for the apex. It fails with `2007: Invalid Input: must be a subdomains of <DOMAIN>`, because `name` is only for subdomains.

### C3. Capture Worker (`worker/`)
1. Create the KV namespace and put its id into `worker/wrangler.toml` under `[[kv_namespaces]]`:
   ```bash
   cd worker && npm ci
   npx wrangler kv namespace create CAPTURE_FALLBACK      # prints the id
   ```
2. Cloud mode: no `BRIDGE_URL`. The Worker needs the `CLOUD` Service Binding to `mailtemp-cloud` (already in `worker/wrangler.toml`; deploy `cloud/` first). Keep `LAST_RESORT = "rethrow"`, `workers_dev = false` and the cron `*/5 * * * *`. Laptop mode needs the version of this Worker before cloud mode (`1c6472bc-8b4b-4c46-99e5-b90ead2f575f`), with `BRIDGE_URL = "https://bridge.<DOMAIN>/ingest"` and the `HMAC_KEY` step below.
3. Set the shared secret to **exactly** the `HMAC_KEY` value from `.env`, then deploy:
   ```bash
   npx wrangler secret put HMAC_KEY        # paste the value from .env
   npx wrangler deploy
   ```
4. Verify:
   ```bash
   npx wrangler deploy --dry-run --outdir /tmp/w | grep -E 'CLOUD|LAST_RESORT'
   npx wrangler secret list 2>/dev/null | jq -r '.[].name'      # HMAC_KEY
   ```
   The deploy output must show `schedule: */5 * * * *`.

### C4. Routing rules: `qa@` plus catch-all, both to the Worker, never forward
```bash
curl -s -X POST "${H[@]}" $API/zones/$Z/email/routing/rules -d '{"name":"qa","enabled":true,"matchers":[{"type":"literal","field":"to","value":"qa@<DOMAIN>"}],"actions":[{"type":"worker","value":["capture-worker"]}]}' | jq .success
curl -s -X PUT "${H[@]}" $API/zones/$Z/email/routing/rules/catch_all -d '{"name":"catch-all","enabled":true,"matchers":[{"type":"all"}],"actions":[{"type":"worker","value":["capture-worker"]}]}' | jq .success
curl -s "${H[@]}" "$API/zones/$Z/email/routing/rules?per_page=50" | jq -r '.result[] | "\(.matchers[0].value // .matchers[0].type) -> \(.actions[0].type):\(.actions[0].value[0] // "") enabled=\(.enabled)"'
```
Expected:
```
qa@<DOMAIN> -> worker:capture-worker enabled=true
all -> worker:capture-worker enabled=true
```
Never add a `forward` action: a rejecting forward target becomes a hard bounce for the sender (ADR-002).

### C5. Tunnel
```bash
A=<ACCOUNT_ID>
TID=$(curl -s -X POST "${H[@]}" $API/accounts/$A/cfd_tunnel -d '{"name":"capture","config_src":"cloudflare"}' | jq -r .result.id); echo $TID
curl -s -X PUT "${H[@]}" $API/accounts/$A/cfd_tunnel/$TID/configurations -d '{"config":{"ingress":[
  {"hostname":"bridge.<DOMAIN>","path":"^/ingest$","service":"http://bridge:8080"},
  {"hostname":"mailpit.<DOMAIN>","path":"^/admin","service":"http://mailpit:8025"},
  {"hostname":"mailpit.<DOMAIN>","service":"http://inbox:8090"},
  {"service":"http_status:404"}]}}' | jq '.success, .result.version'
for n in bridge mailpit; do
  curl -s -X POST "${H[@]}" $API/zones/$Z/dns_records -d "{\"type\":\"CNAME\",\"name\":\"$n.<DOMAIN>\",\"content\":\"$TID.cfargotunnel.com\",\"proxied\":true}" | jq .success
done
```
The order of the ingress lines matters. Keep the `^/admin` line before the default `mailpit` line, and keep the bridge limited to `^/ingest$`.

Put the tunnel token into `.env` without printing it, then start the connector:
```bash
TOKEN=$(curl -s "${H[@]}" $API/accounts/$A/cfd_tunnel/$TID/token | jq -r .result)
sed -i "s|^TUNNEL_TOKEN=.*|TUNNEL_TOKEN=$TOKEN|" .env && unset TOKEN
docker compose --profile tunnel up -d
docker compose logs cloudflared | grep -c 'Registered tunnel connection'    # 4
```

### C6. Status Worker (`status-worker/`)
Cloud mode: it answers every path on `mailpit.<DOMAIN>` with a short "we moved" page that redirects to the cloud inbox after 5 seconds (200 on every HTML path, JSON 410 for API requests) and never calls the origin. Before cloud mode it showed a "service is down, mail is queued" page when the host or tunnel was down (ADR-016). The single route is `mailpit.<DOMAIN>/*`.
```bash
cd status-worker && npx --yes wrangler@4 deploy     # routes come from status-worker/wrangler.toml; edit the host there first (no lockfile, so no npm ci)
```
Expected deploy output: `Deployed mailpit-status-fallback triggers` followed by your route.

Verify: `curl -sI https://mailpit.<DOMAIN>/` must answer `200` (as must `/admin/`), and `/api/status` must answer `410`, with the tunnel up or down.

## A. CI access (live smoke)

CI reads captured mail with its own Mailpit user `ci`, not `root`.

1. On a new host, `bash setup.sh` already created the `ci` user and `secrets/ci.env`. On an existing host, `bash setup.sh` appends the `ci:` line to `secrets/ui_auth`, prints the password once and creates `secrets/ci.env`. Mailpit reads `secrets/ui_auth` only at start (measured: the new user got 401 for 23 s and 200 right after a restart), so run `docker compose restart mailpit` (a few seconds; the Worker queues mail meanwhile).
2. Check: `curl -s -o /dev/null -w '%{http_code}' --doh-url https://cloudflare-dns.com/dns-query -u "ci:<password>" https://mailpit.<DOMAIN>/admin/api/v1/info` gives `200`, and the same with a wrong password gives `401`.
3. In the GitHub repository settings add the Actions secrets `MAILPIT_CI_USER` (value `ci`) and `MAILPIT_CI_PASSWORD` (the value in `secrets/ci.env`).
4. Run the `live-smoke` workflow once from the Actions tab (it runs only on manual dispatch). It is not a required check: it depends on this host being up, and it skips with a notice while the secrets are missing.

## V. Verification checklist

Use **DNS-over-HTTPS** for every DNS check. Some ISPs intercept port-53 DNS. We measured a query to `192.0.2.1`, where no server exists, still getting an answer, so `nslookup`/`dig` showed a stale "parked" answer for hours after the public delegation had already changed.

| Check | Command | Expected |
|---|---|---|
| NS delegated | `curl -s "https://dns.google/resolve?name=<DOMAIN>&type=NS" \| jq -r '.Answer[].data'` | the two Cloudflare name servers of the zone |
| MX live | `curl -s "https://dns.google/resolve?name=<DOMAIN>&type=MX" \| jq -r '.Answer[].data'` | `route1/2/3.mx.cloudflare.net.` |
| App reachable | `curl -s --doh-url https://cloudflare-dns.com/dns-query https://mailpit.<DOMAIN>/healthz` | `ok` (note: `/healthz/` with a trailing slash is 404 by design) |
| Admin protected | `curl -s -o /dev/null -w '%{http_code}' --doh-url https://cloudflare-dns.com/dns-query https://mailpit.<DOMAIN>/admin/` | `401` |
| Bridge locked down | `curl -s -X POST -w ' %{http_code}' --doh-url https://cloudflare-dns.com/dns-query https://bridge.<DOMAIN>/ingest -d x` | `unauthorized 401` |
| Bridge other paths | `curl -s -o /dev/null -w '%{http_code}' --doh-url https://cloudflare-dns.com/dns-query https://bridge.<DOMAIN>/healthz` | `404` |
| Real mail end to end | send a mail from any external mailbox to `hello@<DOMAIN>`, open `https://mailpit.<DOMAIN>/`, type `hello` | the mail appears within about 1 min (the Refresh button has a 5 s cooldown) |
| Plus address | send to `hello+t1@<DOMAIN>` | it appears in `hello`'s inbox |
| CI credential | `curl -s -o /dev/null -w '%{http_code}' --doh-url https://cloudflare-dns.com/dns-query -u ci:<password> https://mailpit.<DOMAIN>/admin/api/v1/info` | `200` (wrong password: `401`) |
| Isolation suite | `bash inbox/test/isolation.sh` (needs `npm ci` in `e2e-helper` plus `npx playwright install chromium`) | `result: 0 failure(s)` |
| Janitor suite | `bash janitor/test/janitor.sh` | `result: 0 failure(s)` (runs in an isolated project) |

## P. Hosting on company infrastructure

- **Domain choice decides the inbox model.**
  - A **dedicated apex domain** owned by the company keeps everything as is: catch-all, any username.
  - A **company subdomain** (for example `qa-mail.<company-domain>`) has **no catch-all**. Every address needs a literal rule (max 200), so the name-based inbox has to change to `qa+<username>@<subdomain>` through subaddressing on a single `qa@` rule: the entry field, the ownership check and the reserved names all change. Enabling routing on a subdomain uses `POST /email/routing/dns` with `{"name":"<subdomain>"}`.
- **Re-issue everything.** Do not copy secrets from the old host. On the new host run `setup.sh` (new `HMAC_KEY`, `INBOX_KEY` and passwords), then repeat C1–C6 in the company Cloudflare account and set the Worker's `HMAC_KEY` secret to the new value.
- **`/admin`.** Use a strong `ADMIN_PASSWORD`. Consider a WAF custom rule that allows `/admin*` only from office IPs.
- **Persistence.** The Docker volumes `mailpit-data`, `bridge-data` and `inbox-data` hold all state. Mail is test data, so backups are optional. `inbox-data` holds the list of names that have been opened and every browser's saved address list (tables `sessions` and `session_accounts`; the session id is stored only as a sha256 hash).
- **Retention.** The default quota is 20 GiB (`MAIL_QUOTA_BYTES`). Size the disk for at least the quota plus a margin, because the SQLite file does not shrink while the apps poll (ADR-012).
- **Cut-over.** Mail goes wherever the MX of `<DOMAIN>` points. Moving the tunnel to the new host is enough for the same domain: stop `cloudflared` on the old host, start it on the new host with the same token, or create a new tunnel and repoint the CNAMEs. Mail arriving during the switch is held in KV and replayed.
