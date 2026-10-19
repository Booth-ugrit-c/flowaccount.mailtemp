# Runbook: system down / mail problems

Work symptom → check → fix. Run commands from the repo root on the host unless the step says otherwise. Cloudflare checks need the API token from `runbook-setup.md` C1 in `$CF_TOKEN`, plus `<ACCOUNT_ID>` and `<ZONE_ID>`.

> The cloud deployment's code (`worker/`, `status-worker/`, `cloud/`) moved to `ugritchaichana/booth-mailtemp`; run the `wrangler` and `worker/` commands below from a clone of that repo (or of this one at tag `v1.0.0` for the self-host Email Worker).

**Cloud mode (current).** `capture-worker` ingests mail straight into `mailtemp-cloud` (D1); the laptop stack, tunnel and bridge are not in the path, and sections 1, 2 and 7-8 apply only if the laptop stack is running. Mail path problems are now: `npx wrangler tail capture-worker` (look for `CAPTURE_DELIVERED`, `CAPTURE_FALLBACK`, `CAPTURE_ERROR`), `curl -s https://mail.booth.pp.ua/api/status` (`d1` must be `ok`), and the buffer: a DOWN alert "mail is not reaching the cloud" means entries sit in `CAPTURE_FALLBACK` for over 10 minutes; once `mailtemp-cloud` answers again the 5-minute cron re-ingests them (15 per run).

**Rule zero: mail is not lost during an outage.**
- If the cloud ingest fails (or, in laptop mode, the bridge, tunnel or host is down), the Worker stores each mail in KV (7-day TTL, up to 1,000 writes/day on Workers Free).
- A cron replays 15 messages every 5 minutes once the bridge answers again.
- Senders see a normal acceptance, not a bounce.
- Do **not** disable Email Routing or the catch-all to "stop" mail. Unmatched addresses would then be rejected, and that **is** a bounce.

## 1. What the page shows

| Symptom | Meaning | Check | Fix |
|---|---|---|---|
| Red banner "Inbox service is down. Your mail is safe and will appear when it is back." | the app runs, but Mailpit does not answer | `docker compose ps mailpit`; `docker compose logs mailpit --tail 50` | `docker compose up -d mailpit`. Data is on volume `mailpit-data`. Incoming mail waits in KV and replays. |
| Yellow banner "New mail is delayed. It is queued and will arrive when the service recovers." | the bridge is down; mail is queued in KV | `docker compose ps bridge`; `curl -s http://127.0.0.1:8080/healthz` | `docker compose up -d bridge`. Queued mail arrives within the next cron runs (15 per 5 min). |
| Red banner "Lost connection to the mail service. Retrying…" | the browser cannot reach the app (tunnel or host) | section 2 | section 2 |
| Status Worker page, title `Mailpit - system is down`, `HTTP 503` | the origin returned 502–504/520–530 or did not answer. Measured: with a tunnel that has no connector the origin answers `530` and `/` serves this page. Only `/` and `/index.html` get it. Other paths such as `/api/status` return the raw `530` by design; once the page is loaded the in-page banner covers them. | section 2 | section 2 |
| Cloudflare error 1033 on `/admin/` | no tunnel connector (the status Worker does not cover `/admin`) | section 2 | section 2 |

Detection latency (measured): the Mailpit and bridge banners appear about 7–9 s after the part goes down (5 s status cache + 5 s poll). The "Lost connection" banner appears about 1.3 s after the app becomes unreachable. Banners hide by themselves on recovery.

## 2. Site unreachable

| Check | Command | Healthy result |
|---|---|---|
| Host up, containers up | `docker compose --profile tunnel ps` | all `running`; `mailpit` `healthy` |
| App local | `curl -s http://127.0.0.1:8090/healthz` | `ok` |
| Tunnel connected | `docker compose logs cloudflared --since 10m \| grep -E 'Registered tunnel connection\|ERR'` | 4 × `Registered tunnel connection … protocol=http2`, no recurring `ERR` |
| Public | `curl -s --doh-url https://cloudflare-dns.com/dns-query https://mailpit.<DOMAIN>/healthz` | `ok` |
| Status Worker | `curl -s -o /dev/null -w "%{http_code}
" --doh-url https://cloudflare-dns.com/dns-query https://mailpit.<DOMAIN>/` | `200` when healthy (the app passes through). `503` with the fallback page means the origin is down (measured: origin `530` with no tunnel connector) |

Fixes, in order:
1. Docker not running: start Docker (Docker Desktop, or `sudo systemctl start docker`), then `docker compose --profile tunnel up -d`.
2. Tunnel down: `docker compose --profile tunnel up -d cloudflared`. If the logs show an auth or token error, see section 6.
3. App down: `docker compose up -d inbox`, then `docker compose logs inbox --tail 50`.
4. Still failing: rebuild from the repo state with `docker compose --profile tunnel up -d --build`.

DNS checks must use DoH (`--doh-url`, or `https://dns.google/resolve?...`). Port-53 lookups can be intercepted by the ISP and show stale answers (measured, see `runbook-setup.md` section V).

## 3. A mail did not arrive

Go down this list until one step shows the problem.

**3a. Did Cloudflare receive it?** Read the Email Routing activity log for the address. Times are UTC; set the window to cover the send time.
```bash
cat > /tmp/q.json <<'EOF'
{"query":"query($zoneTag: string, $filter: EmailRoutingAdaptiveFilter_InputObject){viewer{zones(filter:{zoneTag:$zoneTag}){emailRoutingAdaptive(filter:$filter,limit:50,orderBy:[datetime_DESC]){datetime to status action errorDetail messageId spf dkim dmarc}}}}",
 "variables":{"zoneTag":"<ZONE_ID>","filter":{"datetime_geq":"2026-01-01T00:00:00Z","datetime_leq":"2026-12-31T23:59:59Z","to":"someone@<DOMAIN>"}}}
EOF
curl -s -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" https://api.cloudflare.com/client/v4/graphql --data @/tmp/q.json | jq '.data.viewer.zones[0].emailRoutingAdaptive'
```

| Result | Meaning | Next |
|---|---|---|
| no event | it never reached Cloudflare | check the sender side; check the MX by DoH (`runbook-setup.md` V) |
| `status: "dropped"`, `action: "worker"` | **accepted** and handed to the Worker. This is the normal success status: the Worker consumes the mail and does not forward. | 3b |
| `deliveryFailed` with "temporary error: worker script threw an exception" | the Worker threw; the sender will retry (4xx) | 3c |
| rejected for SPF/DKIM/DMARC | the sender failed authentication | fix the sender's SPF/DKIM; Cloudflare rejects mail that fails both, or fails the sender's DMARC policy |

**3b. Did the Worker push it or queue it?** Read the Worker logs with Workers Observability:
```bash
NOW=$(date +%s000); FROM=$((NOW-3600000))
curl -s -X POST -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/workers/observability/telemetry/query \
  -d "{\"queryId\":\"incident\",\"view\":\"events\",\"limit\":50,\"timeframe\":{\"from\":$FROM,\"to\":$NOW},\"parameters\":{\"filters\":[{\"key\":\"\$metadata.service\",\"operation\":\"eq\",\"type\":\"string\",\"value\":\"capture-worker\"}]}}" \
  | jq -c '.result.events.events[] | .source'
```
Or tail it live: `cd worker && npx wrangler tail capture-worker --format json`.

| Log event | Meaning | Next |
|---|---|---|
| `CAPTURE_DELIVERED` | the bridge accepted it | 3d |
| `CAPTURE_FALLBACK` with `reason: "bridge status 401"` | **`HMAC_KEY` mismatch** | section 6 |
| `CAPTURE_FALLBACK` with another reason (timeout, 5xx, network) | the bridge or tunnel is down; mail is queued | fix section 1/2; it replays automatically |
| `CAPTURE_ERROR stage=replay` (every 5 min) | replay still failing | same as above |
| `CAPTURE_ERROR stage=kv-put` | KV write failed (likely the 1,000/day cap); the Worker rethrows so the sender retries | restore the bridge or tunnel quickly; the KV cap resets daily |

**3c. KV queue.** List the pending mails:
```bash
cd worker && npx wrangler kv key list --binding CAPTURE_FALLBACK --remote 2>/dev/null | jq length
```
A non-zero count drains by 15 every 5 minutes once the bridge answers. Watch for `CAPTURE_DELIVERED … "replay":true` in the Worker logs.

**3d. Bridge and Mailpit.**
```bash
docker compose logs bridge --since 1h | grep -E '"event":"(delivered|already_seen)"' | tail
```
If the mail is in Mailpit but not in the user's inbox:
- Check the exact address. Ownership is `<name>@<DOMAIN>` or `<name>+<tag>@<DOMAIN>`; reserved names (`qa*`, `h13*`, `root`, `admin`, …) are visible only in `/admin/`.
- The user may have deleted it. Delete is per user (soft); the mail still shows in `/admin/`.

## 4. A sender got a bounce

A bounce means a 5xx at the edge. Check, in order:

| Check | Command | Expected |
|---|---|---|
| Rules intact | `curl -s -H "Authorization: Bearer $CF_TOKEN" "https://api.cloudflare.com/client/v4/zones/<ZONE_ID>/email/routing/rules?per_page=50" \| jq -r '.result[] \| "\(.matchers[0].value // .matchers[0].type) -> \(.actions[0].type):\(.actions[0].value[0] // "") \(.enabled)"'` | `qa@<DOMAIN> -> worker:capture-worker true` and `all -> worker:capture-worker true`. **No `forward`.** |
| Routing enabled | `curl -s -H "Authorization: Bearer $CF_TOKEN" https://api.cloudflare.com/client/v4/zones/<ZONE_ID>/email/routing \| jq '.result \| {enabled,status,support_subaddress}'` | `true`, `"ready"`, `true` |
| Worker exists | `curl -s -H "Authorization: Bearer $CF_TOKEN" https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/workers/scripts \| jq -r '.result[].id'` | contains `capture-worker`. A rule pointing at a missing Worker breaks delivery. |
| Size | message size | ≤ 25 MiB. Larger is rejected by Cloudflare by design. |
| Authentication | activity log `spf`/`dkim`/`dmarc` | at least one of SPF/DKIM passes |
| Worker code | `grep -n 'setReject\|forward(' worker/src/index.js` | no matches. `setReject` is a 5xx (measured `555 5.7.1`). |

Fix: restore the missing rule or catch-all (`runbook-setup.md` C4), redeploy the Worker (C3), or remove the offending code and redeploy.

## 5. Janitor and disk

| Symptom | Check | Fix |
|---|---|---|
| Old mail disappeared | `docker compose logs janitor \| grep -v '"deleted":0' \| tail` | Expected once usage reaches 90% of `MAIL_QUOTA_BYTES`: it deletes the oldest mail down to 70%. Raise the quota in `.env` (`MAIL_QUOTA_BYTES=…`), then `docker compose up -d janitor`. |
| Janitor deleting every cycle | the same log; `pct` should drop below 70 after one purge | Must not happen (tested). If it does, set `DRY_RUN=1` in `.env`, run `docker compose up -d janitor`, and collect the logs. |
| Disk filling | `docker system df -v \| grep -E 'mailpit-data\|inbox-data\|bridge-data'` | The SQLite file does not shrink while apps poll; freed pages are reused. Plan disk for the quota plus margin. Never `rm` the database files. |
| Preview a purge | `RUN_ONCE=1 DRY_RUN=1 docker compose run --rm janitor` | prints what would be deleted and deletes nothing |

## 6. Secrets

**`HMAC_KEY` mismatch.** The Worker logs `CAPTURE_FALLBACK … bridge status 401` and KV fills. Make the Worker secret equal to `.env`:
```bash
grep '^HMAC_KEY=' .env | cut -d= -f2- | tr -d '\r\n' | (cd worker && npx wrangler secret put HMAC_KEY)
```
To rotate instead, change `HMAC_KEY` in `.env`, run `docker compose up -d --force-recreate bridge`, then run the command above. Queued mail replays once both sides match.

**Tunnel token rotation or invalid token** (cloudflared logs an auth error). Fetch the current token and restart the connector:
```bash
TOKEN=$(curl -s -H "Authorization: Bearer $CF_TOKEN" https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/cfd_tunnel/<TUNNEL_ID>/token | jq -r .result)
sed -i "s|^TUNNEL_TOKEN=.*|TUNNEL_TOKEN=$TOKEN|" .env && unset TOKEN
docker compose --profile tunnel up -d --force-recreate cloudflared
```

**CI credential rotation or leak** (the `ci` user used by the `live-smoke` workflow). Remove the `ci:` line from `secrets/ui_auth`, delete `secrets/ci.env`, run `bash setup.sh` (it adds a new `ci` line and writes a new `ci.env`), then `docker compose restart mailpit` (Mailpit reads the file only at start). Update the GitHub secrets `MAILPIT_CI_USER` and `MAILPIT_CI_PASSWORD` from the new `secrets/ci.env`. Nothing else depends on this credential, so the apps and `root` are unaffected.

**`/admin` password change.** Edit the `root:` line in `secrets/ui_auth`, then run `docker compose up -d --force-recreate mailpit`. Keep the `qa:` line unchanged: the apps use it, and it must match `MAILPIT_UI_PASSWORD` in `.env`, `secrets/inbox.env` and `secrets/janitor.env`.

## 7. After a host reboot

1. Make sure Docker starts at boot: Docker Desktop's "Start when you sign in", or `systemctl enable docker`. Every service has `restart: unless-stopped`.
2. Check: `docker compose --profile tunnel ps`, with everything `running` and mailpit `healthy`.
3. If cloudflared is not running, start it: `docker compose --profile tunnel up -d`.
4. Verify the public `/healthz` (section 2) and that the KV queue drains (section 3c).

## 8. Restart order and safety

Every service can be restarted on its own; incoming mail is queued in KV meanwhile. If you restart everything, use this order:

```bash
docker compose up -d mailpit                      # 1. storage first
docker compose up -d bridge inbox janitor         # 2. apps that depend on mailpit
docker compose --profile tunnel up -d cloudflared # 3. public traffic last
```

| Service | Safe to restart? | Impact while down |
|---|---|---|
| mailpit | yes | inbox red banner; bridge returns non-2xx, so mail is queued in KV |
| bridge | yes | yellow banner; mail is queued in KV |
| inbox | yes | the site shows the status Worker page or 5xx; mail keeps flowing |
| janitor | yes | none (cleanup pauses) |
| cloudflared | yes | site and bridge unreachable; mail is queued in KV |

Never run `docker compose down -v` on the live host: `-v` deletes all mail and the list of names that have been opened.

## 9. Rollback

| What | Command |
|---|---|
| Capture Worker | `cd worker && npx wrangler versions list` then `npx wrangler rollback <version-id> --name capture-worker`. The last bridge version is `1c6472bc-8b4b-4c46-99e5-b90ead2f575f`; after rolling back to it, start the laptop stack. |
| Status Worker | `cd status-worker && npx wrangler rollback <version-id>`, or delete its routes to disable it |
| Host services | `git checkout <previous-tag-or-commit> && docker compose --profile tunnel up -d --build` |
| Tunnel ingress | `PUT /accounts/<ACCOUNT_ID>/cfd_tunnel/<TUNNEL_ID>/configurations` with the previous ingress (`runbook-setup.md` C5) |
| Routing rules | re-apply `runbook-setup.md` C4; never remove the catch-all while senders are active |
