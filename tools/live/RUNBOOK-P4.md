# Runbook: live tests T-01 to T-04

Send every test mail from a personal mailbox only, never from a company mail system. Keep attachments under 25 MiB for `qa@`.
Record results under `evidence/p4/` and replace personal addresses with `<redacted-email>`.

## 0. One-time setup
1. Put your Cloudflare API token in `.cf-token` (one line). Do not use a token from your user environment.
2. Find your account id: the first run of `bash tools/live/act13-deploy.sh` stops and lists the accounts. Pick yours.
3. Every run (cmd):
   - `set CONFIRM_ACCOUNT_ID=<account id>`
   - `bash tools/live/act13-deploy.sh` (deploy)
   - `bash tools/live/act14-routing.sh` (routing, catch-all stays off)
4. Create the T-03 files once: `bash tools/live/make-mails.sh` (sizes are in `mails/sizes.txt`).
5. Before sending, open the logs, one window each: `bash tools/live/logs.sh h13` and `bash tools/live/logs.sh worker`.

## T-01 Worker failure semantics (gate, run first)
Send one mail to each of `h13-return@`, `h13-throw@`, `h13-cpu@`, `h13-reject@` on your domain.
Record per address:
- the bounce or delay notice text, including the SMTP code
- the Message-ID of the sent mail (Show original)
- the Email Routing activity log: every attempt for that Message-ID, with time and status
- the Worker logs (the `tail` view only shows lines while it is open)

How to read it: exactly one inbound attempt with a success status means 250 accepted; repeated attempts for the same Message-ID at growing intervals means 4xx (the sender is retrying); a bounce means 5xx. A quiet inbox proves nothing, because a 4xx is retried silently for hours.

Watch time: 60 minutes for `h13-return@` and `h13-reject@`; for `h13-throw@` and `h13-cpu@` until a bounce or delay notice arrives or the log shows attempts stopped (at most 24 hours).
Pass: `h13-return@` shows one successful attempt and no bounce (otherwise NO-GO). `h13-reject@` must bounce (control).
When done: `bash tools/live/act14-teardown-h13.sh` (removes the `h13-*` rules first, then the Worker).

## T-02 Routing (gate)
1. Turn on the catch-all: `bash tools/live/act14-routing.sh --catch-all`. Confirm subaddressing is ON (screenshot; see `support_subaddress` in the script output).
2. Send `qa+t02a@` (expect captured, tag `t02a`) and `zz-random@` (expect captured through the catch-all).
3. Turn subaddressing OFF (Dashboard > Email Routing > Settings) and send `qa+t02b@`; record the result.
4. Control: catch-all off and subaddressing OFF, send `zz-unmatched@` and `qa+t02c@`. Expect a bounce (by design); record the SMTP code.
5. Restore subaddressing ON and catch-all ON, send `qa+t02d@`; it must be captured.
For every mail, record the matched rule (`qa@`, catch-all or none) from the Email Routing log.

## T-03 Size and CPU (gate)
- `mails/t03-under-cap.pdf` (15 MiB, raw about 20.5 MiB): attach and send to `qa+t03a@`. Expect captured, attachment sha256 equal to `sizes.txt`, raw size recorded, no `EXCEEDED_CPU` in the Worker logs.
- `mails/t03-over-cap.bin` (20 MiB, raw about 27 MiB): send to `qa+t03b@`. Expect a bounce (control). Record the SMTP code and the Email Routing status.
If the mail provider blocks `.bin`, rename it to `.dat` or zip it without reducing the size, and record the new name.

## T-04 Outage and replay (gate)
One mail per case, to `qa+t04a@`, `qa+t04b@`, `qa+t04c@`, while the part is down:
1. stop the bridge container
2. stop cloudflared
3. power off the PC
Pass: the KV namespace holds a key during the outage; no bounce or delay notice within 60 minutes; after recovery Mailpit holds exactly one mail for that test id within 10 minutes; the KV key is deleted.
Requires the tunnel and `BRIDGE_URL` to be set up first.

## Order
deploy > routing > T-01 > teardown-h13 > routing `--catch-all` > T-02 > T-03 > T-04.
Stop immediately on an Email Routing "Rejected" status or any bounce that was not designed.
