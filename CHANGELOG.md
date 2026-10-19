# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Problem report form on `mailtemp-cloud`: a "Report a problem" button (inbox top bar and add-address dialog) opens a centred form with category, title, details, an optional from/to time and 0 to 20 images (picker, drag and drop, paste, previews, remove; resized in the browser to 2,000 px and re-encoded as JPEG at quality 0.85 when that is smaller, GIFs untouched). `POST /api/report` (multipart, not base64 JSON, so images travel as binary) validates the fields (title up to 120 and details up to 10,000 characters, at most 20 images of 5 MB and 30 MB in total, type by magic bytes), rate limits to 5 reports per hour per IP through `rate_hits`, neutralises every `@` with a zero-width space, commits the images to a private reports repository in one Git Data commit (retried on a push race) and files an issue labelled `report` and `report:<category>` with the images embedded, the time range in Asia/Bangkok and UTC, and the sender's active address, page and browser. The reply is `{"number": N}` only. A GitHub failure is a generic 502 logged with stage, status and GitHub's message only. Config: vars `ISSUES_REPO` and `TURNSTILE_SITE_KEY`, secrets `GITHUB_ISSUES_TOKEN` (fine-grained token limited to the reports repository, Issues and Contents read and write) and `TURNSTILE_SECRET`; `GITHUB_API_BASE` (already used by the admin sign-in tests) also redirects the report calls to a fake GitHub in tests. While `ISSUES_REPO` or `GITHUB_ISSUES_TOKEN` is missing the button is hidden and the API answers 503. New `GET /api/config` returns `{ turnstileSiteKey, reports }`. Owner setup is in the README.
- Cloudflare Turnstile on address creation and reports: once `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET` are both set, `POST /api/open`, `GET /api/random` and `POST /api/report` need a token in the `X-Turnstile-Token` header, verified through `siteverify` for the client IP, this host and the matching action (`open`, `random`, `report`); a missing or rejected token is `403 {"error":"bot check failed"}` and an unreachable `siteverify` fails closed with 503. The widget uses `appearance: "interaction-only"` and a fresh token is fetched for every add-address, random and report attempt. With either value unset nothing is enforced and the widget is not loaded. Rollback: `npx wrangler secret delete TURNSTILE_SECRET` switches it off at once. Scripts that create addresses through the API are blocked by design while it is on.
- Tests for both: unit (`report.test.mjs`, `report-client.test.mjs`; Turnstile ok, failed, reused, wrong host or action, siteverify down, enforced only when configured; validation limits, magic bytes, rate limit, mention neutralising, the Git Data call sequence and retry, issue body, no secret in logs), integration (`report-integration.mjs`: `wrangler dev` with the Turnstile test keys and a local fake GitHub, including a 20-image 30 MB report) and a headless-browser check (`report-browser.mjs`: open, fill, add and remove images, drop and paste, submit, success and error states, token on every add-address and random call, mobile width). The fake GitHub in `cloud/test/fake-github.mjs` gained the Git Data and Issues endpoints. CI runs all of them.
- GitHub sign-in with Owner and Admin roles for `/admin`, replacing the password login (`POST /api/admin/login` and every use of `ADMIN_PASSWORD` are gone). `GET /api/admin/auth/login` redirects to GitHub (empty scope, `state` in a 10 minute SameSite=Lax `mt_oauth` cookie), `GET /api/admin/auth/callback` verifies the state in constant time, exchanges the code, reads the numeric id and login from `GET /user`, discards the token and sets the 12 hour `mt_admin` session. The role is resolved on every request: ids in the `OWNER_GITHUB_IDS` var are Owners, ids in the new `admins` table are Admins, everyone else is refused, and a removed admin is locked out on their next request. Owners also get `GET/POST /api/admin/admins`, `POST /api/admin/admins/remove` (by GitHub username, stored as the numeric id; owner ids cannot be added or removed) and `GET /api/admin/audit`; every delete and every admin add or remove writes an `admin_audit` row. `admin.html` gets a GitHub button, a role badge and owner-only Admins and Audit tabs. While `GITHUB_CLIENT_ID` or the secret `GITHUB_CLIENT_SECRET` is missing every `/api/admin/*` answers 404. New migration `0002_admin_roles.sql` (`IF NOT EXISTS`). Owner setup: create a GitHub OAuth App with homepage `https://mail.booth.pp.ua` and callback `https://mail.booth.pp.ua/api/admin/auth/callback`, set `GITHUB_CLIENT_ID` and `OWNER_GITHUB_IDS` as Worker vars, set the secret with `npx wrangler secret put GITHUB_CLIENT_SECRET`, apply the migration. Tests: unit (`admin-auth.test.mjs`, `admin-mail.test.mjs`), integration and a headless-browser sign-in against a local fake GitHub.
- Admin page for `mailtemp-cloud` at `https://mail.booth.pp.ua/admin`: every message across all names (reserved names such as `qa*`, `h13*` and `root` included) with search by recipient, sender or subject, a message view (sandboxed HTML, Text, Headers, attachments, `.eml` download), storage stats (message count, stored bytes against `STORED_BYTES_CAP`, D1 size, last ingest, oldest message) and multi-select delete (up to 100 per call). Sign-in is GitHub only (see the next entry). The `/admin` page is served by Workers Static Assets from `admin.html` (no Worker code on that path). Janitor and admin share `deleteMessages`, which now removes recipient rows explicitly, because D1 counts cascaded rows in `meta.changes`.
- Live inbox updates on `mailtemp-cloud`: the page polls every 10 s with `GET /api/messages?since=<cursor>` (`cursor` = `MAX(rowid)`, returned on every list response; an idle poll is one D1 row read, a poll with new mail uses the same ownership, hidden and read rules as the full list) and merges by id. It does a full refresh on address switch, on return to the tab, on Refresh and every 5 minutes, and slows to 60 s after 15 minutes without input to protect the account-wide 100,000 requests per day.
- The Text tab shows readable text for HTML-only mail, derived in the browser with `DOMParser` (the HTML is never inserted into the page).
- List snippets for multipart, quoted-printable, base64 and HTML-only mail under 1 MB, computed at ingest (first `text/plain` part, else the first `text/html` part with tags and entities stripped; any error gives an empty snippet). `tools/backfill-snippets.mjs` builds the one-off function that fills existing rows through the Cloudflare MCP.
- `status-worker/` serves a "we moved" notice on every path of `mailpit.booth.pp.ua` (route `mailpit.booth.pp.ua/*`): a short English HTML page (`200` on every HTML path) with a 10-second progress bar (script-driven, so it also moves when the OS reports reduced motion) that redirects to `https://mail.booth.pp.ua/` (`<meta http-equiv="refresh">` fallback), and `410` JSON `{"error":"moved","to":"https://mail.booth.pp.ua/"}` for `/api/`, `/admin/api/` and `Accept: application/json`. It replaces the 302 redirect and no longer depends on the laptop tunnel for any path.
- Import with the original received time: `ingest(raw, envelope, { createdAt })` on `mailtemp-cloud` honours an ISO `createdAt` only when it parses and is at most 5 minutes in the future; otherwise, and by default, the ingest time is used. `tools/migrate-mailpit-to-cloud.mjs` copies a Mailpit inbox through the temporary Worker in `tools/cloud-import-worker/` (bearer secret in `IMPORT_TOKEN`, never in the repo); re-runs are idempotent on the message id.
- Cloud mode: `capture-worker` ingests every mail into `mailtemp-cloud` (`env.CLOUD.ingest`, 15 s timeout) instead of the laptop bridge. A failed ingest goes to the KV fallback exactly as before, the 5-minute cron re-ingests it (15 per run, delete after success), and a KV write failure still rejects the mail. Log: `CAPTURE_DELIVERED` with `target: "cloud"`, `CAPTURE_NOT_STORED` when the cloud answers `stored: false` (no KV retry). The laptop stack, tunnel and watchdog are optional.
- Down alert: also fails a run when the oldest buffered mail is older than 10 minutes (age from the KV expiration), with the count in the message.
- Capture Worker copy hook: after the bridge push succeeds, the mail is also sent to the `mailtemp-cloud` Worker through the optional `CLOUD` Service Binding, inside `waitUntil` with a try/catch that only logs `CLOUD_COPY_OK` or `CLOUD_COPY_ERROR` (size and message id, never addresses or content). No copy when the binding is absent, the push failed, the mail went to the KV buffer, or on replay. Accept/reject, the KV fallback, replay and the down alert are unchanged. Superseded by cloud mode below: ingest is now the primary path and this copy is removed.
- Cloudflare-only version in `cloud/`: a Worker with a D1 database serves the same inbox UI and API (sessions, unlimited addresses, `+tag` names, sort and filter) from `mail.booth.pp.ua`, with no machine to run. Raw mail is stored as chunked base64 text, listed from header-only parsing, and parsed in the browser (postal-mime) for the message view. A cron keeps D1 under its size limit. Nothing feeds it yet; the capture Worker copy hook is a separate change.
- `name+tag` addresses are real inboxes. `test+1` shows only mail to `test+1` and `test+1+...`; `test` still shows every `test+...` mail. `base` follows the existing name rule, `tag` is 1-30 chars `a-z 0-9 . _ -`, one `+` per name, reserved names are checked on `base`.
- The inbox page opens first on every visit. With no address a dim overlay spotlights "Add address"; the button opens a centred modal (focus trap, Enter submits, Esc and backdrop close it only when an address exists).
- Inbox list sort and filter, all in the browser:
  - Sortable headers From, Subject, Size and Received (arrow shows the direction; default Received, newest first; the choice is remembered per browser; a "Sort by" menu replaces the headers on narrow screens).
  - Chips: Unread, Has attachment, 1h / Today / 7d and a Sender menu. A `+tag` is its own address; `to:+tag` in the search narrows to one.
  - Search operators `from:` `to:` `subject:` `has:attachment` `is:unread` with quoted values, combined with free text and the chips; an unknown `x:` is plain text.
  - The state is in the URL hash (`#/?q=...&sort=size.desc&range=today&unread=1&att=1&from=...`), so a link reproduces the view and Back from a message keeps it.
  - The count reads `x of y`, a Clear button resets the filters, and a note appears when the loaded list may be capped.
- The "Addresses in this browser" list is shown with each base followed by its `+tag` addresses (`test`, `test+01`, `test+02`, `test2`, `test2+01`), natural order (`+2` before `+10`). Only the display is sorted; storage is unchanged and no tag entries are created.
- `GET /api/messages` also returns `truncated` (a candidate list reached the 200 cap); `GET /listview.js` serves the parse, filter and sort module that the page and the unit tests share.
- Inbox unit tests (`inbox/test/names.test.mjs`, `listview.test.mjs`, `mail-list.test.mjs`) run in CI.
- Down alert: the capture Worker's 5-minute cron probes `/api/status` and posts to a Discord webhook (`ALERT_WEBHOOK_URL` secret): DOWN after 2 consecutive failed probes, a reminder at most every 2 hours, and RECOVERED with the downtime and the KV-buffered mail count. State lives in a new `MONITOR_STATE` KV namespace. See the README section "Down alert".

### Changed
- `capture-worker` no longer calls the bridge: `BRIDGE_URL` and the HMAC signing are removed; `HMAC_KEY` is unused. The post-push `CLOUD_COPY_OK` / `CLOUD_COPY_ERROR` copy is gone because ingest is the primary path.
- Down alert: `STATUS_URL` is `https://mail.booth.pp.ua/api/status`; healthy means HTTP 200 and every status field (a lowercase word) equal to `"ok"`, not the fixed `mailpit` and `bridge` fields.
- `status-worker/` redirects `mailpit.booth.pp.ua/` and `/index.html` to `https://mail.booth.pp.ua/` (302) instead of serving the "system is down" page. Deep paths on that host are not routed to it.
- `live-smoke` runs on manual dispatch only; the push to `main` trigger is removed because it needs the laptop Mailpit.
- A browser can save any number of addresses (the limit of 10 is gone). The list, its order and the active address are stored server-side in `users.sqlite` (new tables `sessions` and `session_accounts`) under a random session id that is kept only as a sha256 hash; the cookie carries just the signed session id (122 characters, constant). Cookies from the previous release (a list of up to 10 names, or the single-name format) are imported on the first request and replaced, with names, order and active address kept. New browsers are limited to 300 new sessions per IP per hour. The address list in the sidebar scrolls inside a bounded box.
- The separate entry page is gone; adding an address happens in the modal.

### Fixed
- The session cookie was ignored when the browser sent it after another cookie (`a=1; inboxes=...`) because of a mis-escaped regex.

## [1.0.0] - 2026-10-14

First release. Real internet mail for a test domain is captured into Mailpit and shown in a per-address web inbox, so QA no longer needs disposable third-party addresses. Design decisions are in `docs/ADR.md`; operations are in `docs/runbook-setup.md` and `docs/runbook-incident.md`.

### Added
- Capture pipeline: Cloudflare Email Routing (`qa@` rule plus catch-all, subaddressing on) → `capture-worker` (Email Worker) → Cloudflare Tunnel → `bridge` (HMAC-verified, SMTP relay with envelope recipients) → Mailpit.
- KV fallback with cron replay. A failed push is stored in Workers KV (`CAPTURE_FALLBACK`, 7-day TTL) and replayed every 5 minutes, 15 messages per run.
- Web inbox app (`inbox/`), name-based with no passwords:
  - type a username to create or open `<name>@<domain>`
  - up to 10 addresses per browser, with switch and forget
  - Random Username (`rand-xxxxxx`, server-picked, rate-limited)
  - Mailpit theme from vendored Mailpit v1.31.4 assets (MIT)
  - Refresh button with a 5 s cooldown
  - exact To/Cc/Bcc ownership check, Bcc/Received scrubbing, per-user soft delete
- `/admin`: the real Mailpit UI and API behind basic auth (`MP_WEBROOT=admin`).
- Quota janitor (`janitor/`). At 90% of a 20 GiB quota (`MAIL_QUOTA_BYTES`) it deletes the oldest mail until usage is at or below 70%. It measures logical message size incrementally.
- System-down alerts:
  - `GET /api/status` and in-page banners for Mailpit down, bridge down and lost connection
  - the `status-worker/` edge fallback page on `/` and `/index.html` when the host or tunnel is down
- One-command setup: `bash setup.sh`, then `docker compose up -d`. Secrets are created once and never overwritten, and each container gets only its own secrets.
- CI on GitHub Actions:
  - `ci` workflow with `build` (image builds, syntax check, Worker dry-run bundle, status-worker tests) and `test` (full stack, `isolation.sh`, `janitor.sh`)
  - `live-smoke` workflow against the live API
- Separate CI credential (`ci` user) for reading mail through the Mailpit API, distinct from the human admin login.
- Docs: `docs/ADR.md` (ADR-001..ADR-017), `docs/runbook-setup.md`, `docs/runbook-incident.md`.

### Changed
- Mailpit runs with `MP_MAX_MESSAGES=0` and no `MP_MAX_AGE`, so mail has no age expiry. The Mailpit default silently kept only 500 messages.
- `capture-worker` last resort is `LAST_RESORT=rethrow`. When both the push and the KV write fail, the sender gets a temporary failure and retries; nothing bounces.

### Fixed
- `janitor/test/janitor.sh` path conversion now works on Linux CI (`cygpath` is used only when present).

### Verified
- T-01 Worker failure semantics, measured from an external mailbox:
  - a normal return is accepted once
  - a throw is retried by the sender (4xx, 10 retries in about 11 h 47 min)
  - `setReject` is `555 5.7.1`
- T-03 size:
  - a 20.5 MiB raw message is captured byte-identical (sha256 equal), with Worker CPU 25 ms on Workers Free
  - over 25 MiB, the edge answers `552 5.3.4`
- T-04 outage replay: with the bridge down (502) or the tunnel down (530), the sender is still accepted. The mail is stored in KV and replayed exactly once after recovery.
- Test suites: `inbox/test/isolation.sh` 156 PASS, `janitor/test/janitor.sh` 25 PASS, status-worker unit tests 19 PASS.
- `live-smoke` passed on GitHub Actions (run 38516015698, commit 4f62844).

### Known limits
- Mail over 25 MiB is rejected at the edge with `552 5.3.4`, which is a hard bounce for the sender.
- A name-based inbox is readable by anyone who types the name. Use Random Username for addresses that receive codes or reset links.
- The `/admin` password is weak on the current host (owner-accepted). Change it when hosting.
- The `ci` credential has the same Mailpit API scope as `root`: Mailpit has no per-user permissions.
- Workers and KV free quotas apply (KV 1,000 writes per day while the host is down).
- On a single PC, uptime is best effort. Mail is queued in KV during outages.
- A subdomain has no Email Routing catch-all. Hosting on a company subdomain needs the `qa+<name>@` scheme or a dedicated apex domain.
- Required approvals on `main` are 0 until hand-off. Raise them to 1 when the hosting team takes over.

### Monitoring
- 0 hard bounces from the capture domain, tracked since 2026-10-09 with a weekly activity-log check.

### Pinned versions
- `axllent/mailpit:v1.31.4`
- `cloudflare/cloudflared:2026.10.0`
- `node:22.23.3-alpine` (bridge, inbox, janitor)

[1.0.0]: https://github.com/Booth-ugrit-c/flowaccount.mailtemp/releases/tag/v1.0.0
