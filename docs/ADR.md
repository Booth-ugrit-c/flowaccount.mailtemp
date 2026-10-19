# Architecture decisions

All decisions for this project in one file. Status "Accepted" means it is built and running. "Measured" marks behaviour observed on the live system, not taken from docs.

The project receives real internet mail for a test domain and shows it in a web inbox, so QA never has to send to disposable third-party addresses. Those addresses expire, hard-bounce, and get the sender's addresses suppressed by its mail provider.

## Index

| ID | Title | Status | Date |
|---|---|---|---|
| ADR-001 | Capture strategy: own the recipient domain | Accepted | 2026-10-08 |
| ADR-002 | Inbound edge: Cloudflare Email Routing + Email Worker | Accepted | 2026-10-08 |
| ADR-003 | Worker-to-host transport: push through a tunnel, KV fallback, cron replay | Accepted | 2026-10-08 |
| ADR-004 | Never bounce: fallback order and last resort (rethrow) | Accepted (measured) | 2026-10-09 |
| ADR-005 | Worker-to-bridge authentication: HMAC only | Accepted | 2026-10-14 |
| ADR-006 | Bridge hands mail to Mailpit over SMTP with the envelope | Accepted | 2026-10-08 |
| ADR-007 | Domain and addressing: apex domain, catch-all, subaddressing | Accepted | 2026-10-09 |
| ADR-008 | Hosting: Docker Compose on one host, company infrastructure next | Accepted | 2026-10-14 |
| ADR-009 | Email Worker failure semantics | Accepted (measured) | 2026-10-09 |
| ADR-010 | Public web inbox: name-based, no passwords | Accepted | 2026-10-09 |
| ADR-011 | `/admin` is the real Mailpit behind basic auth | Accepted, owner-accepted risk | 2026-10-08 |
| ADR-012 | Retention: 20 GiB quota janitor | Accepted (measured) | 2026-10-09 |
| ADR-013 | Secrets isolated per container | Accepted | 2026-10-08 |
| ADR-014 | One-command setup | Accepted | 2026-10-09 |
| ADR-015 | Public repository, CI and branch protection | Accepted (approvals 0) | 2026-10-14 |
| ADR-016 | System-down alerts on the web page, no notifications | Accepted | 2026-10-14 |
| ADR-017 | Separate CI credential for the Mailpit API | Accepted | 2026-10-14 |

---

## ADR-001 Capture strategy: own the recipient domain

**Context.** Test mail sent to disposable addresses hard-bounces once the address expires. With the usual mail providers (for example Amazon SES), a hard bounce puts the address on the sender's suppression list, and later sends to it are dropped. Many applications also count bounces of every type against the sending user. The application sends mail through several transports: SMTP, provider SDKs, and third-party mailboxes.

**Options.**
- **A. Own a domain and accept everything at its MX.**
- B. Redirect the app's SMTP host to Mailpit. This misses non-SMTP transports and needs changes to the app's secrets.
- C. Plus-addressing on a company mailbox. Mail lands in a real employee inbox, and tests need OAuth to read it.
- D. A provider's mailbox simulator. It returns no mail content.
- E. A SaaS test inbox. That is a new third-party service.
- F. Keep disposable addresses. This keeps the root cause.

**Decision.** A. Capture happens at the recipient's MX, which every transport reaches, and needs no change to the sending application.

**Consequences.**
- (+) One mechanism covers every transport that delivers to an MX.
- (+) Removes the hard-bounce source.
- (−) Never-bounce then depends on how the edge answers. See ADR-004 and ADR-009.
- (−) Mail lands on infrastructure the team must run (ADR-008).

**Status.** Accepted. It has been live since 2026-10-08, and mail from an SES-based sender is captured with DKIM passing.

## ADR-002 Inbound edge: Cloudflare Email Routing + Email Worker

**Context.**
- Internet MTAs deliver on TCP 25.
- The host sits behind NAT, and a tunnel cannot expose raw port 25 to arbitrary senders.

**Options.**
- **A. Cloudflare Email Routing with an Email Worker.**
- B. A public IP running Postfix on port 25. That is a new server, plus IP reputation and abuse handling.
- C. A tunnel straight to Mailpit SMTP. This is not possible for arbitrary MTAs.
- D. An inbound-webhook SaaS.

**Decision.** A. The Worker is the only component that talks SMTP to senders. It never calls `setReject` and never calls `forward`.

**Consequences.**
- (+) Free tier, and no inbound port on the host.
- (−) The domain must use Cloudflare DNS, and Cloudflare takes over the MX.
- (−) Edge limits apply:
  - Inbound messages over **25 MiB** are rejected: "Messages larger than this are rejected" (Cloudflare Email Routing limits).
  - Mail that fails both SPF and DKIM, or fails the sender's DMARC policy, is rejected.
- (−) `forward()` is unusable for never-bounce: "Hard bounces are returned to the original sender in-session" (Cloudflare email lifecycle docs).

**Status.** Accepted.

## ADR-003 Worker-to-host transport: push through a tunnel, KV fallback, cron replay

**Context.** The Worker runs at Cloudflare and Mailpit runs on a host behind NAT. Workers KV on the Free plan allows 1,000 writes per day.

**Options.**
- **A. Push: Worker `fetch()` → Cloudflare Tunnel public hostname → bridge.**
- B. Push through a Workers VPC binding. This was beta at the time.
- C. Pull: the Worker stores every message in KV and the host polls. That costs KV quota on every message.

**Decision.** A.
- On any push failure, the Worker stores the raw message in KV (`CAPTURE_FALLBACK`, TTL 7 days).
- A Cron Trigger (`*/5 * * * *`) replays up to 15 KV entries per run to the bridge.
- The envelope `from`/`to` and a capture id travel as HTTP headers; the raw bytes are never edited.

**Consequences.**
- (+) The happy path uses no KV quota.
- (+) The host holds no Cloudflare credential.
- (−) There is a public hostname to defend (ADR-005).
- (−) Replay throughput is about 180 messages per hour (15 every 5 min).
- (−) While the host is down, the KV write cap of 1,000 per day bounds how much mail can be held.

**Status.** Accepted. **Measured:**
- Cron triggers work on Workers Free.
- A replay probe went Worker → tunnel → bridge → Mailpit and logged `"event":"CAPTURE_DELIVERED","replay":true`.
- The KV key was removed after delivery.

## ADR-004 Never bounce: fallback order and last resort (rethrow)

**Context.**
- A 5xx from the edge is a hard bounce, which leads to suppression.
- A 4xx makes the sender retry. SES, for example, retries for up to 14 h by default, then records a transient bounce.
- `message.raw` can be read only once, so it is buffered before the push.

**Decision.**
1. Buffer `message.raw` once.
2. Push to the bridge with a timeout.
3. On a non-2xx, an exception or a timeout, write the buffered message to KV and return normally (the sender sees acceptance).
4. **Last resort, when the KV write also fails: rethrow** (`LAST_RESORT = "rethrow"`). Measured in ADR-009: an exception makes the sender retry with a temporary error, so the mail is delayed, not bounced.
5. Never call `setReject` or `forward`.

**Consequences.**
- (+) A host, tunnel or bridge outage ends as "stored, replayed later", with nothing visible to the sender.
- (−) If KV stays unwritable for the sender's whole retry window, the sender records a transient bounce.
- (−) If buffering itself fails, the Worker logs `CAPTURE_ERROR stage=buffer` and returns normally, and that message is lost.

**Status.** Accepted (measured, 2026-10-09).

## ADR-005 Worker-to-bridge authentication: HMAC only

**Context.** The bridge sits behind a public hostname. The threats are spoofed POSTs (fake mail in tests), floods and replays.

**Options.**
- A. A Cloudflare Access service token plus HMAC.
- **B. HMAC only.**
- C. No public hostname (Workers VPC). This was beta.

**Decision.** B. The project does not use Zero Trust or Access (owner decision, 2026-10-14).
- The Worker sends `X-Capture-Signature` = HMAC-SHA256 over `captureId.timestamp.sha256(body)`, plus `X-Capture-Id`, `X-Capture-Timestamp`, `X-Envelope-From` and `X-Envelope-To`.
- The bridge rejects a timestamp outside ±300 s, a bad signature, or a missing recipient.
- A capture id it has already seen gets `200 already-seen`, so replays are idempotent.
- The tunnel ingress for the bridge host exposes only the path `^/ingest$`; everything else is 404.

**Consequences.**
- (+) No extra account dependency.
- (−) Unauthenticated floods still reach the host; the bridge answers them 401.
- (−) The `HMAC_KEY` must be identical in the Worker secret and the host `.env`.

**Status.** Accepted. **Measured:** an unsigned `POST /ingest` through the tunnel returns the bridge's own `401 unauthorized`, and `/healthz` on that host returns 404.

## ADR-006 Bridge hands mail to Mailpit over SMTP with the envelope

**Options.**
- **A. SMTP relay to Mailpit `:1025`**, with `MAIL FROM` = envelope from and one `RCPT TO` per envelope recipient.
- B. Mailpit `POST /api/v1/send`. It rebuilds the MIME, so the original bytes are lost.

**Decision.** A. The bridge answers 2xx to the Worker only after Mailpit answers 250 to `DATA`. Delivery is at least once, and the capture-id seen-set makes it effectively once.

**Consequences.**
- (+) The original bytes are kept; Mailpit prepends `Return-Path` and one `Received` header.
- (+) BCC and cc-myself copies arrive.
- (+) Plus-address tags are automatic.
- (−) Envelope-only recipients appear in Mailpit's `Bcc` field. Any per-user view must hide them (ADR-010).
- Mailpit's message size limit is set explicitly: `MP_MAX_MESSAGE_SIZE=30` (MB), above the 25 MiB edge cap.

**Status.** Accepted. Image pinned to `axllent/mailpit:v1.31.4`.

## ADR-007 Domain and addressing: apex domain, catch-all, subaddressing

**Context.**
- Catch-all works only on an apex domain: "Catch-all entries support apex domains only. To route mail sent to an Email Routing subdomain, list each address" (Cloudflare docs). Each domain allows 200 routing rules.
- Subaddressing is opt-in. With it on, `user+tag@` matches the `user@` rule, and `+tag` is kept in `message.to`.

**Decision.**
- Use a dedicated domain as its own apex zone, for example `booth.pp.ua` (replace with yours).
- Turn subaddressing on.
- Create a literal rule `qa@` and a catch-all, both pointing to the Worker.
- Create no forward rules, ever.

**Consequences.**
- (+) Any local part is accepted, so a typo never becomes a bounce. This also makes the name-based inbox (ADR-010) possible.
- (−) The catch-all also receives internet spam (see ADR-012 for space).
- (−) **On a company subdomain there is no catch-all.** The name-based inbox would then need `qa+<username>@subdomain` (subaddressing on the `qa@` rule) or a dedicated apex domain. Decide this before hosting on company DNS (see `runbook-setup.md`).

**Status.** Accepted. **Measured:**
- Mail to arbitrary names was captured through the catch-all.
- An external test of `qa+tag@` is still pending.

## ADR-008 Hosting: Docker Compose on one host, company infrastructure next

**Decision.**
- All host-side services run as one Docker Compose project: `mailpit`, `bridge`, `inbox`, `janitor`, and `cloudflared` (profile `tunnel`, protocol `http2`).
- Host ports are bound to `127.0.0.1`; public traffic arrives only through the tunnel.
- The stack runs on the owner's PC now and will be handed to the team to host on company servers.

**Consequences.**
- (+) Portable: `bash setup.sh && docker compose up -d` (ADR-014).
- (−) While the host is off, the web UI is down. Mail is held in KV and replayed (ADR-003).
- (−) A single host is a single point of failure until it moves.

**Status.** Accepted for the current phase.

## ADR-009 Email Worker failure semantics

**Context.** Cloudflare does not document what the sender sees when an Email Worker throws, exceeds CPU, or returns without an action.

**Decision.** Measure it with a probe Worker before relying on any branch. One mail per variant was sent from an external mailbox, and each was classified from the Email Routing activity log per Message-ID, never from inbox silence.

**Results (measured 2026-10-08/09).**

| Worker behaviour | Sender sees | Evidence |
|---|---|---|
| Returns normally (no forward) | Accepted: one attempt, status `dropped`, no NDR in 16 h | one log event, no retry |
| Throws an exception | **Temporary failure, the sender retries** | the same Message-ID retried 10 times in about 11 h 47 min, each logged as "temporary error: worker script threw an exception" |
| `setReject(reason)` | **5xx**: `555 5.7.1 <reason>` | sender NDR |
| Uses 101 ms CPU on Workers Free | Accepted (no failure) | the over-CPU failure path is **untested**, so its semantics are unknown |

**Consequences.** This settles ADR-004 (rethrow). A large-message test near 25 MiB is still pending to show how buffering behaves under CPU limits.

**Status.** Accepted (fact record). The probe Worker and its rules were removed afterwards.

## ADR-010 Public web inbox: name-based, no passwords

**Context.**
- Mailpit has one shared mailbox: "these are **not** separate accounts (they all allow access to the same Mailpit instance)" (Mailpit docs, passwords).
- QA wanted the simplest possible use: type a name and read its mail.

**Decision.** A separate `inbox` web app is served at the site root.
- **Entry.** The page is always the inbox layout. "Add address" opens a modal with one field: the username, with the domain fixed. A new name is created; an existing name opens with its history. With no address (first visit, forgotten last address, lost session) the page is dimmed with a spotlight on "Add address". There are no passwords and no sign-in or sign-out.
- **Name shape.** `base` or `base+tag`. `base` is 3-30 chars `a-z 0-9 . _ -` starting with a letter or digit; `tag` is 1-30 chars `a-z 0-9 . _ -`; exactly one `+` is allowed. `base+tag` is its own address: it sees mail to `base+tag` and `base+tag+...` only, while `base` still sees every `base+...` mail. One `+` keeps the ownership rule trivial: the owner prefix is the whole name and a tag can never contain the separator. Names are stored lower-case.
- **Session.** A signed (`INBOX_KEY`) HttpOnly cookie, SameSite=Lax, valid for 1 year, marked Secure over https. It carries only a session id; the list of addresses, their order and the active one live server-side in `users.sqlite` (tables `sessions`, `session_accounts`), with no limit on the number of addresses. Switching to a name that is not in the session returns 403. "Forget" removes an address from this browser only.
- **Random Username.** The server picks an unused `rand-xxxxxx` name. Requests are limited to 30 per minute per IP, and the button has a 2 s cooldown.
- **Limits.** At most 30 new names per IP per hour; opening an existing name is unlimited.
- **Reserved names cannot be opened:** the check runs on `base`, so `root+1` and `qa1+x` are refused too. Anything starting with `qa` or `h13`, plus `root`, `admin`, `postmaster`, `abuse`, `hostmaster`, `webmaster`, `noreply`, `no-reply`, `security` and `support`. Mail to them is visible only in `/admin`.
- **Isolation, checked server-side on every request:**
  - A message belongs to a user only when a To, Cc or Bcc address has the domain and the local part `<name>` or `<name>+<tag>`, matched exactly. Mailpit search only narrows the candidates, because its `addressed:` filter matches substrings.
  - `Bcc:` and `Received ... for <addr>` are scrubbed from raw and header views, so recipients cannot see each other.
  - The message id must equal the requested id, because Mailpit's `latest` alias would otherwise bypass the check.
  - Delete is a per-user soft delete (hidden for that user only).
- **UI.** It mirrors Mailpit's look by vendoring Mailpit v1.31.4's compiled CSS, icon font and logo (MIT, licence file included). It is English only and has a Refresh button with a 5 s cooldown.

**Consequences.**
- (+) Zero friction for QA.
- (−) **Anyone who types a username sees that inbox** (owner-accepted, Mailinator-like). Use Random Username for accounts that receive codes or reset links.
- (−) The isolation logic is ours to maintain. It is covered by `inbox/test/isolation.sh`, with 148 cases including mutation checks.

**Status.** Accepted.

## ADR-011 `/admin` is the real Mailpit behind basic auth

**Decision.**
- Mailpit runs with `MP_WEBROOT=admin`, and the tunnel routes `^/admin` to it.
- `secrets/ui_auth` holds two users: `qa` (used server-side by the apps) and `root` (people).
- Zero Trust/Access is not used.

**Consequences.**
- (−) `/admin` shows all mail, and basic auth alone protects it from the internet. **On the owner's instance the root password is weak by owner choice.**
- **When hosting, set a strong `ADMIN_PASSWORD` before the first `setup.sh`.** Alternatively, restrict `/admin` by IP with a Cloudflare WAF custom rule, which the Free plan allows (5 rules).

**Status.** Accepted, with an owner-accepted risk.

## ADR-012 Retention: 20 GiB quota janitor

**Context.**
- **Measured:** inside Docker Desktop the volume reports a 1 TB virtual disk at 0% while the real host drive is mostly used by other files, so "disk percent" is meaningless there.
- Mailpit's defaults silently cap the mailbox at 500 messages (`MP_MAX_MESSAGES`).
- Read from the Mailpit v1.31.4 source: `DeleteMessages` does not vacuum. Auto-vacuum runs only after the database has been idle for 5 minutes and at least 1% of storage was deleted. Any list or read resets the idle timer.

**Decision.**
- There is no age expiry. Mailpit runs with `MP_MAX_MESSAGES=0` and no `MP_MAX_AGE`.
- A `janitor` service keeps a running logical total of message `Size` through the Mailpit API: a full scan at start, then incremental scans. A count mismatch, or 6 hours passing, forces a rescan.
- When the total reaches 90% of `MAIL_QUOTA_BYTES` (default 20 GiB), it deletes the oldest messages first, by receipt time, in batches with explicit IDs, until the total is at or below 70%.

**Consequences.**
- (+) No delete spiral: the next cycle after a purge deletes nothing (tested).
- (+) A full scan of 20,000 messages took about 0.6–0.8 s.
- (−) The SQLite file does not shrink while the apps are polling; it plateaus because freed pages are reused.
- Capacity estimate from measured sizes: about 155k mails with a PDF attachment (about 135 KB each), up to about 1.25M short mails (about 17 KB).

**Status.** Accepted. The test is `janitor/test/janitor.sh` (25 cases, isolated project).

## ADR-013 Secrets isolated per container

**Decision.** Each container gets only the secrets it needs:

| Container | Reads | Holds |
|---|---|---|
| bridge | `.env` | `HMAC_KEY` and the `qa` credentials |
| inbox (public-facing) | `secrets/inbox.env` | `INBOX_KEY` and the `qa` credentials only; never `HMAC_KEY` or `TUNNEL_TOKEN` |
| janitor | `secrets/janitor.env` | the `qa` credentials |
| cloudflared | `.env` | `TUNNEL_TOKEN` only |
| GitHub Actions `live-smoke` | repository secrets | the `ci` credential only (from `secrets/ci.env`; nothing on the host reads that file) |

**Status.** Accepted. Verified by listing the environment variable names inside each container.

## ADR-014 One-command setup

**Decision.**
- `docker-compose.yml` sits at the repo root with `name: capture-poc`.
- `bash setup.sh` creates `.env`, `secrets/ui_auth`, `secrets/inbox.env` and `secrets/janitor.env` with random values. It never overwrites existing files; the only edit it makes to one is appending the `ci:` line to `secrets/ui_auth` when it is missing (ADR-017).
- Host ports and image tags can be overridden through environment variables.

**Status.** Accepted. Verified on a clean copy: `setup.sh`, then `docker compose up -d`, gave every service healthy and `/admin` 401 without auth and 200 with the generated password.

## ADR-015 Public repository, CI and branch protection

**Decision.**
- The code (not the research notes) lives in a public GitHub repo.
- GitHub Actions workflow `ci` has two jobs, `build` and `test`:
  - `build`: image builds, a syntax check and a Worker dry-run bundle.
  - `test`: the full stack plus `isolation.sh` and `janitor.sh` on ubuntu-latest.
- `main` is protected:
  - required checks `build` and `test` (strict)
  - a pull request is required, but 0 approving reviews (owner decision 2026-10-14: single-account project, and an owner cannot self-approve)
  - enforced for admins
  - no force push or deletion

**Consequences.**
- Merges are gated by green `build` + `test` only. `strict` (the branch must be up to date with `main`) and `enforce_admins` stay on, and force pushes and deletions stay blocked.
- No human review is enforced while one account runs the project.
- When the hosting team takes over, raise required approvals to 1 so a second person reviews every change.

**Status.** Accepted (approvals reduced from 1 to 0 on 2026-10-14). Measured protection: `{"approvals":0,"checks":["build","test"],"enforce_admins":true,"strict":true}`. Before publishing, a secret scan found 0 live values in the tracked files.

## ADR-016 System-down alerts on the web page, no notifications

**Context.** QA relies on the site daily. The owner chose a visible on-page alert over push notifications.

**Decision.**
- The `inbox` app serves `GET /api/status` → `{mailpit, bridge}` as `ok` or `down`, with 1 s timeouts and a 5 s cache. The page shows a banner:
  - Mailpit down: "Inbox service is down. Your mail is safe and will appear when it is back."
  - bridge down: "New mail is delayed. It is queued and will arrive when the service recovers."
  - browser lost the app: "Lost connection to the mail service. Retrying…"
- When the host or tunnel is down the page cannot load at all. A small edge Worker (`status-worker/`, since moved to `ugritchaichana/booth-mailtemp`) runs **only** on routes `<host>/` and `<host>/index.html`, so API polling never uses Worker quota. It passes the origin through, and serves a self-contained "service is down, mail is queued" page when the origin throws or returns 502–504 or 520–530.

**Consequences.**
- (+) **Measured:** with a tunnel that has no connector, the origin answers `530`, and the Worker on `/` serves its fallback: `HTTP 503`, `<title>Mailpit - system is down</title>`. Measured on a temporary test host, since removed.
- (+) **Measured:** healthy traffic passes through: `/` returns 200 with the app page, and `/index.html` returns 200.
- (+) **Measured detection latency:** about 7–9 s for the Mailpit and bridge banners (5 s status cache + 5 s poll), and about 1.3 s for "Lost connection" when the app is unreachable.
- (−) A non-root path such as `/api/status` returns the raw `530` by design. Once the page is loaded, the in-page banner covers that case.
- (−) `/admin` is not covered: with no connector it shows Cloudflare error 1033.

**Status.** Accepted. Deployed as Worker `mailpit-status-fallback` on routes `<host>/` and `<host>/index.html`. Deploy steps are in `runbook-setup.md` C6.

## ADR-017 Separate CI credential for the Mailpit API

**Context.** E2E specs address `qa+<test-id>@<domain>`, which the public inbox cannot read by design (reserved names), so CI reads captured mail through the Mailpit API at `/admin/api/v1`. Using `root` or `qa` for that would tie CI to the credential people use or to the one the apps share.

**Decision.**
- `setup.sh` adds a `ci:<random 24 hex>` user to `secrets/ui_auth` and writes it to `secrets/ci.env` (gitignored). The values become the GitHub secrets `MAILPIT_CI_USER` and `MAILPIT_CI_PASSWORD`.
- A `live-smoke` workflow (manual and on push to `main`) runs `e2e-helper/live-smoke.spec.ts` against the public API. It is not a required check because it needs the host to be up, and it skips with a notice when the secrets are missing.

**Consequences.**
- (+) The credential can be rotated alone (runbook-incident section 6) without touching `root`, `qa` or the apps, and CI access can be told apart from people and apps.
- (−) Mailpit basic auth has no per-user scope: `ci` can do everything `root` can, including delete. The "read only" nature is the spec's discipline, not an enforcement. The separation buys rotation and attribution, nothing more.
- **Measured:** Mailpit reads the auth file only at start: a user appended to the file got 401 for 23 s and 200 after a restart. Adding the user to a running host therefore needs `docker compose restart mailpit` (a few seconds).
- CI jobs that run `setup.sh` on an ephemeral stack print a generated `ci` password in the public log; that stack is thrown away, so the value is worthless.

**Status.** Accepted. Verified on the live host: `ci` gets 200 and a wrong password 401 on `/admin/api/v1/info`, `root` and `qa` still 200, and the spec passes with the CI credential.
