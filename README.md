# Mailpit inbound capture

Receives real internet mail for a domain and gives every visitor a private inbox on a Mailpit-styled web page. Mail goes Cloudflare Email Routing -> Worker -> tunnel -> `bridge` -> Mailpit. The `inbox` app shows each visitor only mail addressed to their own address; the real Mailpit UI is admin-only at `/admin/`.

| Folder | What it is |
|---|---|
| `worker/` | Cloudflare Email Worker that signs and forwards each mail to the bridge |
| `bridge/` | Node 22 service: verifies the signature, relays the mail to Mailpit over SMTP |
| `inbox/` | Node 22 web app: create-or-open an address, switch addresses, read mail |
| `e2e-helper/` | Playwright helper for reading captured mail in tests |
| `tools/` | Local test scripts and the live Cloudflare scripts (`tools/live/`) |

## Quickstart

```bash
git clone <this repo> && cd <repo>
bash setup.sh                 # creates .env and secrets/ once; never overwrites existing files
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
| `secrets/ui_auth` | Mailpit basic-auth users: `qa` for the apps, `root` for people |
| `secrets/inbox.env` | `INBOX_KEY` (signs the session cookie) and the `qa` credentials; only the inbox container reads it |

Mailpit options used: `MP_MAX_MESSAGE_SIZE=30` (MB), `MP_MAX_MESSAGES=0` (no count cap; the default would keep only 500), `MP_DATABASE=/data/mailpit.db`, `MP_UI_AUTH_FILE=/run/secrets/ui_auth`, `MP_WEBROOT=admin`. There is no age expiry: the `janitor` service frees space by quota.

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
