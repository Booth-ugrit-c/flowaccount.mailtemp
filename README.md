# Mailpit inbound capture

Receives real internet mail for a domain and gives every visitor a private inbox on a Mailpit-styled web page. In cloud mode (see "Cloud mode") mail goes Cloudflare Email Routing -> `capture-worker` -> `mailtemp-cloud` (D1) and the inbox is `https://mail.booth.pp.ua/`; the laptop stack (Email Routing -> Worker -> tunnel -> `bridge` -> Mailpit) is optional. The `inbox` app shows each visitor only mail addressed to their own address; the real Mailpit UI is admin-only at `/admin/`.

Version `1.0.0`. Release notes: [CHANGELOG.md](CHANGELOG.md).

| Folder | What it is |
|---|---|
| `worker/` | Cloudflare Email Worker (`capture-worker`): ingests each mail into `cloud/` through a Service Binding, buffers failures in KV, runs the down alert |
| `bridge/` | Node 22 service: verifies the signature, relays the mail to Mailpit over SMTP |
| `inbox/` | Node 22 web app: create-or-open an address, switch addresses, read mail |
| `cloud/` | Cloudflare-only version: one Worker with D1 and static assets, no machine to run (see "Cloud version") |
| `e2e-helper/` | Playwright helper for reading captured mail in tests |
| `status-worker/` | Cloudflare Worker that answers every path on `mailpit.booth.pp.ua` with a short "we moved" page that redirects to `https://mail.booth.pp.ua/` (not deployed by the repo) |
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

## Cloud mode

Mail path: Email Routing (`qa@` rule and catch-all, unchanged) -> `capture-worker` -> `env.CLOUD.ingest(raw, { from, to })` on the `mailtemp-cloud` Service Binding -> D1. The inbox is `https://mail.booth.pp.ua/`. No machine has to run.

- If `ingest` throws or times out (15 s), the mail is stored in KV (`CAPTURE_FALLBACK`, 7-day TTL) and the 5-minute cron re-ingests 15 entries per run, deleting each only after it succeeds. `ingest` is idempotent on the message id, so a replay never doubles a mail. If the KV write also fails, the Worker rejects the mail (`LAST_RESORT = "rethrow"`), as before.
- The bridge is no longer in the path and `BRIDGE_URL` is gone from `worker/wrangler.toml`. `HMAC_KEY` is no longer read.
- The down alert watches `https://mail.booth.pp.ua/api/status` and the age of the oldest buffered mail (see "Down alert").
- Every path on `mailpit.booth.pp.ua` is answered by `status-worker/` with a "we moved" notice (HTTP 200 on every HTML path, redirecting to the new root after 10 seconds; JSON 410 for API requests); the laptop tunnel is no longer reached.
- `live-smoke` runs only on manual dispatch; it needs the laptop Mailpit.
- The laptop stack (`docker compose`, the tunnel, the watchdog task) is optional. Keep its volumes if old mail may be imported later.
- Rollback: `cd worker && npx wrangler rollback 1c6472bc-8b4b-4c46-99e5-b90ead2f575f --name capture-worker` (the last bridge version; set the version id from `npx wrangler versions list` if it has changed), then start the laptop stack again. `cd status-worker && npx wrangler rollback <version-id>` restores the old fallback page.

## Cloud version (`cloud/`)

One Worker (`mailtemp-cloud`) serves the inbox UI and API from Workers Static Assets and keeps mail in D1: an index row, one row per recipient, and the raw message as base64 text chunks of 1,440,000 bytes (a D1 row holds at most 2,000,000). Mail reaches it through an RPC method, never a public route: `env.CLOUD.ingest(raw, { from, to })` on a Service Binding. The message view is parsed in the browser from `/api/messages/:id/raw` with a vendored copy of postal-mime (`cloud/public/vendor/postal-mime.js`, MIT-0, version 4.0.7, bundled from the npm package).

- Free-tier shape: the UI polls every 10 s with `GET /api/messages?since=<cursor>` (an idle poll reads one D1 row; a full refresh runs on switch, on return to the tab, on Refresh and every 5 minutes), slows to every 60 s after 15 minutes without input, and polls only while the tab is visible, because every API call counts against the 100,000 requests per day; static files are free. A cron (every 10 min) deletes the oldest whole messages when stored bytes pass `STORED_BYTES_CAP` (400 MB, below the 500 MB D1 limit) and removes chunks left by a failed ingest.
- Deploy (own account): `cd cloud && npm ci`, create the database with `npx wrangler d1 create mailtemp-cloud` and put its id in `wrangler.toml`, then `npx wrangler d1 migrations apply DB --remote`, `npx wrangler secret put SESSION_KEY`, `npx wrangler deploy`, and add the Custom Domain for the host.
- Admin (`/admin`): one page for every message across all names, reserved ones included (`cloud/public/admin.html`, API under `/api/admin/*` in `cloud/src/admin.js`). It lists with search over recipient, sender and subject (100 per page, `before=<rowid>` cursor), opens a message (sandboxed HTML, Text, Headers, attachments, `.eml` download), shows storage stats (message count, stored bytes against `STORED_BYTES_CAP`, D1 size, last ingest, oldest message) and deletes selected messages (up to 100 per call; chunks, recipients, reads and hides go with them).
- Admin sign-in and roles: the only way in is "Sign in with GitHub" (OAuth App, empty scope, so only the public profile is read; the GitHub token is used once for `GET /user` and then discarded, never stored or logged). Access is decided by the numeric GitHub id, never the login. An **Owner** (ids in the `OWNER_GITHUB_IDS` var, comma separated) can do everything an **Admin** can and also list, add (by GitHub username, resolved to the id) and remove admins and read the audit log (latest 200 entries). An **Admin** (a row in the `admins` table) gets mail, stats and delete only; every owner route answers 403. Anyone else gets a 403 page. The role is looked up on every request, so a removed admin is locked out on their next request. Owners cannot be added or removed through the page. Every delete and every admin add or remove writes an `admin_audit` row (who, what, target; ids and logins only, never mail content). The session is the `mt_admin` cookie (`<id>.<login>.<expires>.<hmac>`, HttpOnly, Secure, SameSite=Strict, `Path=/api/admin`, 12 h, signed with `SESSION_KEY`); the login handshake uses a 10 minute `mt_oauth` state cookie that is SameSite=Lax (the callback is a cross-site navigation from github.com, which Strict would drop) and is checked against the `state` parameter in constant time. Every POST also needs `Content-Type: application/json` and `X-Admin: 1`. While `GITHUB_CLIENT_ID` or the secret `GITHUB_CLIENT_SECRET` is missing, every `/api/admin/*` answers 404. `GITHUB_OAUTH_BASE` and `GITHUB_API_BASE` exist only so the tests can point at a local fake GitHub; leave them unset in production. The log records login success or failure with the numeric id, admin changes with ids, and delete counts.
- Admin setup (once, by the owner): (1) in GitHub, Settings > Developer settings > OAuth Apps > New OAuth App, with Homepage URL `https://mail.booth.pp.ua` and Authorization callback URL `https://mail.booth.pp.ua/api/admin/auth/callback`; (2) put the app's client id in the `GITHUB_CLIENT_ID` var and the owners' numeric GitHub ids in `OWNER_GITHUB_IDS` in the deploy config; (3) store the client secret with `npx wrangler secret put GITHUB_CLIENT_SECRET`; (4) apply `cloud/migrations/0002_admin_roles.sql` to the D1 database (it only creates the `admins` and `admin_audit` tables, `IF NOT EXISTS`) and deploy.
- Import: `ingest` takes an optional third argument `{ createdAt }` (ISO string, ignored when invalid or more than 5 minutes ahead). `tools/migrate-mailpit-to-cloud.mjs` reads a Mailpit inbox and posts each message to a temporary Worker (`tools/cloud-import-worker/`) that calls `ingest`; set `MAILPIT_USER`, `MAILPIT_PASSWORD`, `IMPORT_URL`, `IMPORT_TOKEN` (`DRY_RUN=1` lists without sending). Delete that Worker when the import is done.
- Tests: `node --test "cloud/test/*.test.mjs"` (unit, runs on a SQLite stand-in for D1) and `node cloud/test/integration.mjs` (starts `wrangler dev --local` with a probe Worker that calls `ingest`; CI runs both). `node cloud/test/admin-browser.mjs` drives `/admin` in headless Chromium against the same local `wrangler dev`, signing in through a local fake GitHub (`cloud/test/fake-github.mjs`, served on `localhost` so the callback really is cross-site) as an owner, an admin and an unlisted account (Playwright from `e2e-helper/`; CI runs it in the `test` job). Against a deployed copy, set `PROBE_URL`, `PROBE_TOKEN` and `PUBLIC_URL` and run the same script: the probe Worker (`cloud/test/probe/`) is deployed only for that check and deleted afterwards.

## Service status and outage alerts

The page tells the user when something is down. No notifications are sent; the alert is the page itself.

`GET /api/status` (no login, always HTTP 200) returns `{"mailpit":"ok|down","bridge":"ok|down","checkedAt":"<ISO time>"}`. Mailpit is checked through its API at `MAILPIT_URL`, the bridge at `BRIDGE_HEALTH_URL` (default `http://bridge:8080/healthz`). Each check has a 1 s timeout and the result is cached for 5 s. The response carries no internal detail.

The page polls it every 5 s (the same timer as the mail list), on a first visit and in the inbox, and shows a banner that disappears when the service recovers:

| Condition | Banner |
|---|---|
| Mailpit down | red: "Inbox service is down. Your mail is safe and will appear when it is back." |
| Bridge down | yellow: "New mail is delayed. It is queued and will arrive when the service recovers." |
| The browser cannot reach the app after the page has loaded (fetch fails, or the edge answers 502/503/504/520-530) | red: "Lost connection to the mail service. Retrying..." |

Detection takes up to about 10 s (5 s cache plus the 5 s poll).

### Down alert (`worker/`)

Every 5-minute cron run of the capture Worker probes `STATUS_URL` (`https://mail.booth.pp.ua/api/status`, 8 s timeout) and looks at the oldest mail in `CAPTURE_FALLBACK`. A run is healthy when the probe answers HTTP 200 and every status field in the JSON (a lowercase word such as `"ok"`, `"down"`, `"error"`; timestamps and numbers are ignored) is `"ok"`, with at least one such field, and no buffered mail is older than 10 minutes (age is derived from the KV expiration). Anything else is a failed run, and the reason names the failing fields and, for mail that is not reaching the cloud, the buffered count and the oldest age. It posts to a Discord webhook:

- DOWN once, after 2 consecutive failed probes, with the reason (status code or the component that is not ok);
- a "still DOWN" reminder at most every 2 hours;
- RECOVERED once on the first healthy probe, with the downtime and the number of mails buffered in `CAPTURE_FALLBACK`.

Messages never contain mail addresses or content. The monitor runs beside the replay loop through `ctx.waitUntil`, so a monitor failure cannot block the replay.

- Secret: `npx wrangler secret put ALERT_WEBHOOK_URL` (a Discord webhook URL; keep it out of the repo). Without it the monitor logs `MONITOR_DISABLED` and does nothing.
- State: a separate KV namespace bound as `MONITOR_STATE` (create it with `npx wrangler kv namespace create MONITOR_STATE` and put the id in `worker/wrangler.toml`). It is written only when the state changes.
- Test without downtime: set `STATUS_URL` in `worker/wrangler.toml` to a path that returns a non-200 status, deploy, wait for two cron runs (DOWN), restore the real value, deploy, wait one run (RECOVERED).
- Turn off: `npx wrangler secret delete ALERT_WEBHOOK_URL`.
- Tests (no dependencies): `node --test "worker/test/*.test.js"`; CI runs them in the `build` job.

### Moved notice (`status-worker/`)

`status-worker/` is a small Cloudflare Worker on the single route `mailpit.booth.pp.ua/*`. It never calls the origin, so the old host keeps answering after the laptop stack is off.

- Every HTML path, deep paths included: `200` and one self-contained English page (inline CSS, light and dark, `noindex`) with a progress bar and a "Go now" button. After 10 seconds it redirects to `https://mail.booth.pp.ua/` (`location.replace`, with `<meta http-equiv="refresh">` as the no-JavaScript fallback; a script counts 10 to 1 and widens the bar each second, with a glide that `prefers-reduced-motion` turns into a one-second step).
- Paths under `/api/` or `/admin/api/`, or `Accept: application/json`: `410` with `{"error":"moved","to":"https://mail.booth.pp.ua/"}`.

- Deploy with `cd status-worker && npx wrangler deploy` using your own Cloudflare account. The repo never deploys it.
- Tests (no dependencies): `node --test "status-worker/test/*.test.js"`; CI runs them in the `build` job.
- Outage test for the banners: `bash inbox/test/outage.sh` stops and starts services of an isolated compose project (`outagecheck`, ports 38025/38080/38090); it never touches the running stack.

## CI access to the mail API

E2E tests address `qa+<test-id>@<domain>`, which the public inbox cannot read (reserved names), so CI reads captured mail through the Mailpit API at `/admin/api/v1` with its own user `ci`. `setup.sh` adds the `ci:<random>` line to `secrets/ui_auth` and writes `secrets/ci.env`; Mailpit reads the auth file only at start, so run `docker compose restart mailpit` once after the line is added to an existing host.

Upload the two values from `secrets/ci.env` as the repository secrets `MAILPIT_CI_USER` and `MAILPIT_CI_PASSWORD`. The `live-smoke` workflow (manual dispatch only since cloud mode; it needs the laptop Mailpit) then runs `e2e-helper/live-smoke.spec.ts` against the public API: the API answers, the captured `t03a` message and its attachment metadata (no download), and a wrong password is rejected. It is **not** a required check (it needs the host to be up) and skips with a notice when the secrets are missing. Local run: `cd e2e-helper && set -a && . ../secrets/ci.env && set +a && MAILPIT_URL=https://<host>/admin MAILPIT_USER=$MAILPIT_CI_USER MAILPIT_PASSWORD=$MAILPIT_CI_PASSWORD npx playwright test --config playwright.live.config.ts`. Mailpit has no per-user permissions, so `ci` can do everything `root` can; the spec only reads.

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
- `node --test "inbox/test/*.test.mjs"` runs the name, ownership, session, cookie-migration, list sort/filter and list-truncation unit tests (no stack needed).
- `bash inbox/test/isolation.sh` runs against the running stack (needs `curl`, `jq`, `openssl`, and Node with Playwright from `e2e-helper/node_modules` for the browser checks).
- `bash tools/l-bridge.sh` and `bash tools/l-worker.sh` are local bridge/Worker checks. They delete all Mailpit mail, so run them only on a disposable stack.
- Run the Worker locally with Node >= 22: `cd worker && npm install && npx wrangler dev --local --test-scheduled`, with `HMAC_KEY` in `worker/.dev.vars`.

## Notes

- The inbox list sorts by column and filters with chips and search operators, in the browser, on the loaded mail only (at most 200 direct plus 200 `name+` candidates per address; the page says so when the cap is hit). Search takes `from:` `to:` `subject:` `has:attachment` `is:unread` (values may be quoted: `from:"john smith"`) plus free text; every part must match. The view is kept in the URL hash, for example `#/?q=from%3Abob&sort=size.desc&range=today&unread=1&att=1&from=bob%40example.com`.
- Anyone who types a username sees that inbox (Mailinator style). `name+tag` is its own inbox (for example `test+1`) and `name` also shows every `name+tag` mail. Reserved names (`qa*`, `h13*`, `root`, `admin`, ...) cannot be opened, so those mails are visible only in `/admin/`.
- `/admin/` is protected by basic auth only; choose a strong `ADMIN_PASSWORD`.
