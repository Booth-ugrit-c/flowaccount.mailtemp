# Mailpit inbound capture

Receives real internet mail for a domain and gives every visitor a private inbox on a Mailpit-styled web page. Mail goes Cloudflare Email Routing -> Worker -> tunnel -> `bridge` -> Mailpit. The `inbox` app shows each visitor only mail addressed to their own address; the real Mailpit UI is admin-only at `/admin/`.

Version `1.0.0`. Release notes: [CHANGELOG.md](CHANGELOG.md).

| Folder | What it is |
|---|---|
| `worker/` | Cloudflare Email Worker that signs and forwards each mail to the bridge |
| `bridge/` | Node 22 service: verifies the signature, relays the mail to Mailpit over SMTP |
| `inbox/` | Node 22 web app: create-or-open an address, switch addresses, read mail |
| `e2e-helper/` | Playwright helper for reading captured mail in tests |
| `status-worker/` | Optional Cloudflare Worker that shows a "system is down" page when the origin is unreachable (not deployed by the repo) |
| `tools/` | Local test scripts and the live Cloudflare scripts (`tools/live/`) |

## Quickstart

```bash
git clone <this repo> && cd <repo>
bash setup.sh                 # creates .env and secrets/ once; never overwrites existing files (it only appends the `ci` user to `secrets/ui_auth` when missing)
docker compose up -d          # mailpit, bridge, inbox
```

- Inbox app: http://127.0.0.1:8090
- Mailpit admin: http://127.0.0.1:8025/admin/ (login `root` with the password `setup.sh` printed, or set `ADMIN_PASSWORD=... bash setup.sh` before the first run)
- Bridge health: http://127.0.0.1:8080/healthz

Host ports are `127.0.0.1` only. To run a second copy beside it, override the ports and image tags: `MAILPIT_HOST_PORT=18025 BRIDGE_HOST_PORT=18080 INBOX_HOST_PORT=18090 BRIDGE_IMAGE=second-bridge INBOX_IMAGE=second-inbox docker compose -p second up -d --build`.

Optional tunnel, once `TUNNEL_TOKEN` is set in `.env`:

```bash
docker compose --profile tunnel up -d
```

## Cloudflare side (one time, your own account)

1. Put an API token in `.cf-token` (one line) and read `tools/live/RUNBOOK-P4.md`.
2. Deploy the Worker (`worker/`) with `tools/live/act13-deploy.sh`; set its `HMAC_KEY` secret to the value in `.env`.
3. Point Email Routing at the Worker (catch-all -> Worker) with `tools/live/act14-routing.sh`.
4. Create a tunnel and add ingress: path `^/admin` -> `http://mailpit:8025`, everything else -> `http://inbox:8090`; put the tunnel token in `.env`.
5. Check logs with `tools/live/logs.sh`.

## Configuration

| File | Content |
|---|---|
| `.env` | `HMAC_KEY` (shared with the Worker), `MAILPIT_UI_USER`/`MAILPIT_UI_PASSWORD` (the `qa` account used by tools), `TUNNEL_TOKEN` |
| `secrets/ui_auth` | Mailpit basic-auth users: `qa` for the apps, `root` for people, `ci` for the CI live check |
| `secrets/ci.env` | `MAILPIT_CI_USER` and `MAILPIT_CI_PASSWORD`: upload these as GitHub repository secrets (see CI access below); nothing on the host reads this file |
| `secrets/inbox.env` | `INBOX_KEY` (signs the session cookie) and the `qa` credentials; only the inbox container reads it |

Mailpit options used: `MP_MAX_MESSAGE_SIZE=30` (MB), `MP_MAX_MESSAGES=0` (no count cap; the default would keep only 500), `MP_DATABASE=/data/mailpit.db`, `MP_UI_AUTH_FILE=/run/secrets/ui_auth`, `MP_WEBROOT=admin`. There is no age expiry: the `janitor` service frees space by quota.

## Service status and outage alerts

The page tells the user when something is down. No notifications are sent; the alert is the page itself.

`GET /api/status` (no login, always HTTP 200) returns `{"mailpit":"ok|down","bridge":"ok|down","checkedAt":"<ISO time>"}`. Mailpit is checked through its API at `MAILPIT_URL`, the bridge at `BRIDGE_HEALTH_URL` (default `http://bridge:8080/healthz`). Each check has a 1 s timeout and the result is cached for 5 s. The response carries no internal detail.

The page polls it every 5 s (the same timer as the mail list), on the entry card and in the inbox, and shows a banner that disappears when the service recovers:

| Condition | Banner |
|---|---|
| Mailpit down | red: "Inbox service is down. Your mail is safe and will appear when it is back." |
| Bridge down | yellow: "New mail is delayed. It is queued and will arrive when the service recovers." |
| The browser cannot reach the app after the page has loaded (fetch fails, or the edge answers 502/503/504/520-530) | red: "Lost connection to the mail service. Retrying..." |

Detection takes up to about 10 s (5 s cache plus the 5 s poll).

### Down alert (`worker/`)

Every 5-minute cron run of the capture Worker probes `STATUS_URL` (default `https://mailpit.booth.pp.ua/api/status`, 8 s timeout). Healthy means HTTP 200 with `mailpit` and `bridge` both `"ok"`; anything else is a failed probe. It posts to a Discord webhook:

- DOWN once, after 2 consecutive failed probes, with the reason (status code or the component that is not ok);
- a "still DOWN" reminder at most every 2 hours;
- RECOVERED once on the first healthy probe, with the downtime and the number of mails buffered in `CAPTURE_FALLBACK`.

Messages never contain mail addresses or content. The monitor runs beside the replay loop through `ctx.waitUntil`, so a monitor failure cannot block the replay.

- Secret: `npx wrangler secret put ALERT_WEBHOOK_URL` (a Discord webhook URL; keep it out of the repo). Without it the monitor logs `MONITOR_DISABLED` and does nothing.
- State: a separate KV namespace bound as `MONITOR_STATE` (create it with `npx wrangler kv namespace create MONITOR_STATE` and put the id in `worker/wrangler.toml`). It is written only when the state changes.
- Test without downtime: set `STATUS_URL` in `worker/wrangler.toml` to a path that returns a non-200 status, deploy, wait for two cron runs (DOWN), restore the real value, deploy, wait one run (RECOVERED).
- Turn off: `npx wrangler secret delete ALERT_WEBHOOK_URL`.
- Tests (no dependencies): `node --test "worker/test/*.test.js"`; CI runs them in the `build` job.

### Edge fallback (`status-worker/`)

If the PC, the tunnel or the app is down, the browser cannot load the page at all, so no in-page banner is possible. `status-worker/` is a small Cloudflare Worker that sits in front of the page: it fetches the origin, and when that throws or answers 502/503/504/520-530 (a tunnel without a connector answers 530) it serves a self-contained "System is down, mail is queued" page (HTTP 503, inline CSS, no external assets) that retries every 15 s and reloads when the service is back. Everything else passes through untouched.

- Deploy it on exactly two routes, `<host>/` and `<host>/index.html` (already set in `status-worker/wrangler.toml`; change the host and `zone_name` for your domain). Do not route `/api/*` or a wildcard: the status polling would count against the Workers request quota.
- Deploy with `cd status-worker && npx wrangler deploy` using your own Cloudflare account. The repo never deploys it.
- Tests (no dependencies): `node --test "status-worker/test/*.test.js"`; CI runs them in the `build` job.
- Outage test for the banners: `bash inbox/test/outage.sh` stops and starts services of an isolated compose project (`outagecheck`, ports 38025/38080/38090); it never touches the running stack.

## CI access to the mail API

E2E tests address `qa+<test-id>@<domain>`, which the public inbox cannot read (reserved names), so CI reads captured mail through the Mailpit API at `/admin/api/v1` with its own user `ci`. `setup.sh` adds the `ci:<random>` line to `secrets/ui_auth` and writes `secrets/ci.env`; Mailpit reads the auth file only at start, so run `docker compose restart mailpit` once after the line is added to an existing host.

Upload the two values from `secrets/ci.env` as the repository secrets `MAILPIT_CI_USER` and `MAILPIT_CI_PASSWORD`. The `live-smoke` workflow (manual or on push to `main`) then runs `e2e-helper/live-smoke.spec.ts` against the public API: the API answers, the captured `t03a` message and its attachment metadata (no download), and a wrong password is rejected. It is **not** a required check (it needs the host to be up) and skips with a notice when the secrets are missing. Local run: `cd e2e-helper && set -a && . ../secrets/ci.env && set +a && MAILPIT_URL=https://<host>/admin MAILPIT_USER=$MAILPIT_CI_USER MAILPIT_PASSWORD=$MAILPIT_CI_PASSWORD npx playwright test --config playwright.live.config.ts`. Mailpit has no per-user permissions, so `ci` can do everything `root` can; the spec only reads.

## Mail quota (janitor)

Mail is never deleted by age. The `janitor` service keeps a running total of message sizes (through the Mailpit API) and, once the total reaches `HIGH_WATERMARK_PCT` of the quota, deletes the oldest mail until it is at or below `LOW_WATERMARK_PCT`. It logs one JSON line per cycle (`usage`, `pct`, `deleted`, `freedEstimate`, `rescan`, `fileBytes`).

| Variable (set in `.env` or the shell) | Default | Meaning |
|---|---|---|
| `MAIL_QUOTA_BYTES` | 21474836480 (20 GiB) | quota the percentages refer to |
| `HIGH_WATERMARK_PCT` | 90 | start deleting at this usage |
| `LOW_WATERMARK_PCT` | 70 | stop deleting at this usage |
| `INTERVAL_SECONDS` | 60 | time between cycles |
| `DRY_RUN` | 0 | 1 = log what would be deleted, delete nothing |
| `RUN_ONCE` | 0 | 1 = run one cycle and exit |
| `RESCAN_HOURS` | 6 | full re-count interval (safety net; a mismatch with the Mailpit total also triggers one) |

The quota counts message bytes, not the SQLite file: SQLite keeps its file size after deletes and Mailpit only vacuums after 5 idle minutes, so the file size is a poor measure. `docker compose logs janitor` shows both numbers. Test: `bash janitor/test/janitor.sh` (isolated project, never touches the running stack).

## Tests

- `bash janitor/test/janitor.sh` checks the quota janitor in an isolated compose project.
- `bash inbox/test/isolation.sh` runs against the running stack (needs `curl`, `jq`, `openssl`, and Node with Playwright from `e2e-helper/node_modules` for the browser checks).
- `bash tools/l-bridge.sh` and `bash tools/l-worker.sh` are local bridge/Worker checks. They delete all Mailpit mail, so run them only on a disposable stack.
- Run the Worker locally with Node >= 22: `cd worker && npm install && npx wrangler dev --local --test-scheduled`, with `HMAC_KEY` in `worker/.dev.vars`.

## Notes

- Anyone who types a username sees that inbox (Mailinator style). Reserved names (`qa*`, `h13*`, `root`, `admin`, ...) cannot be opened, so those mails are visible only in `/admin/`.
- `/admin/` is protected by basic auth only; choose a strong `ADMIN_PASSWORD`.
