# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

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
