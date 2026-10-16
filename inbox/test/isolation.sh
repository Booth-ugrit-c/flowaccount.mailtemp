#!/usr/bin/env bash
set -u
cd "$(dirname "$0")/../.."

INBOX=${INBOX_URL:-http://127.0.0.1:8090}
BRIDGE=${BRIDGE_URL:-http://127.0.0.1:8080/ingest}
MAILPIT=${MAILPIT_URL:-http://127.0.0.1:8025}
COMPOSE=${COMPOSE:-docker compose}
DOMAIN=booth.pp.ua
envv() { grep -m1 "^$1=" .env | cut -d= -f2- | tr -d '[:cntrl:]'; }
HMAC_KEY=$(envv HMAC_KEY)
INBOX_KEY=$(grep -m1 "^INBOX_KEY=" secrets/inbox.env | cut -d= -f2- | tr -d "[:cntrl:]")
MP_USER=$(envv MAILPIT_UI_USER)
MP_AUTH="$MP_USER:$(envv MAILPIT_UI_PASSWORD)"
CI_AUTH="$(grep -m1 '^MAILPIT_CI_USER=' secrets/ci.env | cut -d= -f2- | tr -d '[:cntrl:]'):$(grep -m1 '^MAILPIT_CI_PASSWORD=' secrets/ci.env | cut -d= -f2- | tr -d '[:cntrl:]')"
ROOT_AUTH="root:$(grep -m1 "^root:" secrets/ui_auth | cut -d: -f2- | tr -d "[:cntrl:]")"

RUN=$(openssl rand -hex 4)
TMP=$(mktemp -d)
rand_ip() { echo "10.$((RANDOM % 250 + 1)).$((RANDOM % 250 + 1)).$((RANDOM % 250 + 1))"; }
IP_MAIN=$(rand_ip); IP_LIMIT=$(rand_ip)
RANDOM_NAMES=
FAILS=0

pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1  ($2)"; FAILS=$((FAILS + 1)); }
expect() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "expected $3, got $2"; fi; }
expect_one_of() { case " $3 " in *" $2 "*) pass "$1";; *) fail "$1" "expected one of [$3], got $2";; esac; }

mp() { curl -s -u "$MP_AUTH" "$@"; }
mp_count() { mp -G "$MAILPIT/admin/api/v1/search" --data-urlencode "query=subject:\"$1\"" | jq -r '.messages_count'; }

cleanup() {
  local ids users
  ids=$(mp -G "$MAILPIT/admin/api/v1/search" --data-urlencode "query=subject:\"isolation-$RUN\"" --data-urlencode "limit=200" | jq -c 'select(.messages_count > 0) | {IDs: [.messages[].ID]}')
  [ -n "$ids" ] && mp -X DELETE -H 'Content-Type: application/json' -d "$ids" "$MAILPIT/admin/api/v1/messages" > /dev/null
  users=$($COMPOSE exec -T inbox node --disable-warning=ExperimentalWarning -e "
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync('/data/users.sqlite');
    const p = '%-$RUN%';
    let removed = 0;
    for (const name of '${RANDOM_NAMES}'.split(' ').filter(Boolean).concat(p)) {
      db.prepare('DELETE FROM hidden WHERE username LIKE ?').run(name);
      db.prepare('DELETE FROM session_accounts WHERE username LIKE ?').run(name);
      removed += Number(db.prepare('DELETE FROM users WHERE username LIKE ?').run(name).changes);
    }
    db.exec(\"DELETE FROM sessions WHERE id NOT IN (SELECT session FROM session_accounts) AND created < strftime('%s','now') - 300\");
    console.log(removed)" 2>/dev/null | tr -d '[:cntrl:]')
  rm -rf "$TMP"
  echo "cleanup: removed ${users:-?} test accounts and $( [ "$(mp_count "isolation-$RUN")" = "0" ] && echo "all isolation-$RUN messages" || echo "NOT all messages")"
  [ "$(mp_count "isolation-$RUN")" = "0" ] || FAILS=$((FAILS + 1))
  echo "result: $FAILS failure(s)"
  [ "$FAILS" = "0" ] || exit 1
}
trap cleanup EXIT

post() { curl -s -o "$TMP/out.json" -w '%{http_code}' -X POST -H "CF-Connecting-IP: ${4:-$IP_MAIN}" -H 'Content-Type: application/json' -c "$TMP/${3:-anon}.jar" -b "$TMP/${3:-anon}.jar" -d "$2" "$INBOX$1"; }
open_inbox() { post /api/open "{\"username\":\"$1\"}" "${2:-$1}" "${3:-$IP_MAIN}"; }
call() { curl -s -o "$TMP/out.json" -w '%{http_code}' -X "${3:-GET}" -b "$TMP/$1.jar" "$INBOX$2"; }
has_cookie() { grep -q $'\tinboxes\t[^\t]' "$TMP/$1.jar" 2>/dev/null && echo yes || echo no; }

make_eml() {
  local file=$1 to=$2 subject=$3 attach=${4:-}
  {
    printf 'From: sender@example.com\r\nTo: %s\r\nSubject: %s\r\nMessage-ID: <%s@isolation.test>\r\nDate: Thu, 08 Oct 2026 10:00:00 +0000\r\nMIME-Version: 1.0\r\n' "$to" "$subject" "$(openssl rand -hex 8)"
    if [ -n "$attach" ]; then
      printf 'Content-Type: multipart/mixed; boundary="BND"\r\n\r\n--BND\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nbody of %s\r\n--BND\r\nContent-Type: application/octet-stream; name="a.bin"\r\nContent-Disposition: attachment; filename="a.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\naGVsbG8=\r\n--BND--\r\n' "$subject"
    else
      printf 'Content-Type: text/plain; charset=UTF-8\r\n\r\nbody of %s\r\n' "$subject"
    fi
  } > "$file"
}

inject() {
  local header_to=$1 envelope_to=$2 subject=$3 attach=${4:-}
  local eml="$TMP/$(openssl rand -hex 4).eml" id ts hash sig status
  make_eml "$eml" "$header_to" "$subject" "$attach"
  id=$(openssl rand -hex 16)
  ts=$(date +%s)
  hash=$(openssl dgst -sha256 -r < "$eml" | cut -d' ' -f1)
  sig=$(printf '%s.%s.%s' "$id" "$ts" "$hash" | openssl dgst -sha256 -hmac "$HMAC_KEY" -r | cut -d' ' -f1)
  status=$(curl -s -o /dev/null -w '%{http_code}' -X POST --data-binary "@$eml" \
    -H "X-Capture-Id: $id" -H "X-Capture-Timestamp: $ts" -H "X-Capture-Signature: $sig" \
    -H 'X-Envelope-From: sender@example.com' -H "X-Envelope-To: $envelope_to" -H 'Content-Type: message/rfc822' "$BRIDGE")
  [ "$status" = "200" ] || { fail "inject '$subject'" "bridge status $status"; return 1; }
  for _ in 1 2 3 4 5; do [ "$(mp_count "$subject")" -ge 1 ] 2>/dev/null && return 0; sleep 1; done
  fail "inject '$subject'" "not in Mailpit"
  return 1
}

subject_count() { call "$1" /api/messages > /dev/null; jq --arg s "$2" '[.messages[] | select(.subject == $s)] | length' "$TMP/out.json"; }
subject_id() { call "$1" /api/messages > /dev/null; jq -r --arg s "$2" '[.messages[] | select(.subject == $s)][0].id' "$TMP/out.json" | tr -d '[:cntrl:]'; }
wait_visible() {
  for _ in 1 2 3 4 5; do [ "$(subject_count "$1" "$2")" = "1" ] && return 0; sleep 1; done
  return 1
}
visible() { wait_visible "$1" "$2" && pass "$3" || fail "$3" "not listed"; }
invisible() { expect "$3" "$(subject_count "$1" "$2")" 0; }

for url in "$INBOX/healthz" "${BRIDGE%/ingest}/healthz"; do
  [ "$(curl -s -m 3 -o /dev/null -w '%{http_code}' "$url")" = "200" ] || { fail "preflight" "$url is not healthy"; exit 1; }
done
[ "$(mp -m 3 -o /dev/null -w '%{http_code}' "$MAILPIT/admin/api/v1/info")" = "200" ] || { fail "preflight" "Mailpit admin API not reachable with .env credentials"; exit 1; }

A=alice-$RUN; B=bob-$RUN

expect "open a new username -> 200" "$(open_inbox "$A")" 200
expect "new username reports created:true" "$(jq -r .created "$TMP/out.json")" true
expect "opening sets a session cookie" "$(has_cookie "$A")" yes
expect "GET /api/me returns the active username" "$(call "$A" /api/me > /dev/null; jq -r .active "$TMP/out.json")" "$A"
expect "open the same username again -> 200" "$(open_inbox "$A" alice-again)" 200
expect "existing username reports created:false" "$(jq -r .created "$TMP/out.json")" false
expect "second visit gets its own session cookie" "$(has_cookie alice-again)" yes
expect "open a second new username -> 200" "$(open_inbox "$B")" 200

for name in qa qa1 h13x root admin postmaster ab "Bad Name" "$A@booth.pp.ua" qa+1 qa1+x h13x+1 root+1 "$A+" "+tag" "$A+a+b" "$A++b" "$A+Bad Tag" "$A+$(printf 'x%.0s' $(seq 1 31))"; do
  expect "open '$name' -> 400" "$(open_inbox "$name" bad)" 400
done
expect "reserved name sets no cookie" "$(has_cookie bad)" no
expect "open with a form content type -> 415" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -d "username=form-$RUN" "$INBOX/api/open")" 415

expect "no cookie on /api/messages -> 401" "$(call nobody /api/messages)" 401
cookie_of() { awk -F'	' '$6 == "inboxes" {print $7}' "$TMP/$1.jar" | tr -d '[:cntrl:]'; }
sid_of() { cookie_of "$1" | cut -d. -f2; }
tail_of() { cookie_of "$1" | cut -d. -f3-; }
forged_cookie() {
  local sid iat
  sid=$(openssl rand 32 | openssl base64 -A | tr '+/' '-_' | tr -d '=')
  iat=$(date +%s)
  echo "v3.$sid.$iat.$(printf 'v3:%s.%s' "$sid" "$iat" | openssl dgst -sha256 -hmac "$INBOX_KEY" -r | cut -d' ' -f1)"
}
status_with_cookie() { curl -s -o /dev/null -w '%{http_code}' -H "Cookie: $1" "$INBOX${2:-/api/messages}"; }
COOKIE=$(cookie_of "$A")
TAMPERED="${COOKIE%?}$([ "${COOKIE: -1}" = "0" ] && echo 1 || echo 0)"
expect "tampered cookie on /api/messages -> 401" "$(status_with_cookie "inboxes=$TAMPERED")" 401
expect "alice's signature under bob's session id -> 401" "$(status_with_cookie "inboxes=v3.$(sid_of "$B").$(tail_of "$A")")" 401
expect "a validly signed cookie for an unknown session id -> 401" "$(status_with_cookie "inboxes=$(forged_cookie)")" 401
expect "cookie lifetime is one year" "$(curl -s -D - -o /dev/null -X POST -H 'Content-Type: application/json' -d "{\"username\":\"$A\"}" "$INBOX/api/open" | grep -io 'max-age=[0-9]*' | head -1 | tr -d '[:cntrl:]')" "Max-Age=31536000"

S_OWN="isolation-$RUN plain"; S_TAG="isolation-$RUN plus-tag"; S_ENV="isolation-$RUN envelope-only"
inject "$A@$DOMAIN" "$A@$DOMAIN" "$S_OWN"
inject "$A+tag@$DOMAIN" "$A+tag@$DOMAIN" "$S_TAG"
inject "someone-else@example.com" "$A@$DOMAIN" "$S_ENV"
visible "$A" "$S_OWN" "mail to alice@ is visible to alice"
visible "$A" "$S_TAG" "mail to alice+tag@ is visible to alice"
visible "$A" "$S_ENV" "envelope-only alice is visible to alice"
invisible "$B" "$S_OWN" "mail to alice@ is invisible to bob"

S_X="isolation-$RUN x-prefix"; S_SUFFIX="isolation-$RUN x-suffix"; S_BOB="isolation-$RUN bob-mail"; S_QA="isolation-$RUN qa-leak"; S_DOM="isolation-$RUN other-domain"
inject "x$A@$DOMAIN" "x$A@$DOMAIN" "$S_X"
inject "${A}x@$DOMAIN" "${A}x@$DOMAIN" "$S_SUFFIX"
inject "$B@$DOMAIN" "$B@$DOMAIN" "$S_BOB" attach
inject "qa+leak@$DOMAIN" "qa+leak@$DOMAIN" "$S_QA"
inject "$A@example.com" "$A@example.com" "$S_DOM"
invisible "$A" "$S_X" "mail to xalice@ is invisible to alice"
invisible "$A" "$S_SUFFIX" "mail to alicex@ is invisible to alice"
invisible "$A" "$S_BOB" "mail to bob@ is invisible to alice"
invisible "$A" "$S_QA" "mail to qa+leak@ is invisible to alice"
invisible "$B" "$S_QA" "mail to qa+leak@ is invisible to bob"
invisible "$A" "$S_DOM" "mail to alice@ on another domain is invisible to alice"
visible "$B" "$S_BOB" "mail to bob@ is visible to bob"

B_ID=$(subject_id "$B" "$S_BOB")
expect "bob reads his own message -> 200" "$(call "$B" "/api/messages/$B_ID")" 200
PART=$(jq -r '.attachments[0].partId' "$TMP/out.json" | tr -d '[:cntrl:]')
expect "bob reads his own attachment -> 200" "$(call "$B" "/api/messages/$B_ID/part/$PART")" 200
expect "bob reads his own raw source -> 200" "$(call "$B" "/api/messages/$B_ID/raw")" 200
expect "bob reads his own headers -> 200" "$(call "$B" "/api/messages/$B_ID/headers")" 200
expect_one_of "alice's cookie on bob's message -> 403 or 404" "$(call "$A" "/api/messages/$B_ID")" "403 404"
expect_one_of "alice's cookie on bob's attachment -> 403 or 404" "$(call "$A" "/api/messages/$B_ID/part/$PART")" "403 404"
expect_one_of "alice's cookie on bob's raw source -> 403 or 404" "$(call "$A" "/api/messages/$B_ID/raw")" "403 404"
expect_one_of "alice's cookie on bob's headers -> 403 or 404" "$(call "$A" "/api/messages/$B_ID/headers")" "403 404"
expect_one_of "alice's cookie on bob's delete -> 403 or 404" "$(call "$A" "/api/messages/$B_ID" DELETE)" "403 404"
expect "bob's message survives alice's delete attempt" "$(subject_count "$B" "$S_BOB")" 1
expect_one_of "message id 'latest' is not a way around the check -> 403 or 404" "$(call "$A" /api/messages/latest)" "403 404"

S_BOTH="isolation-$RUN shared-by-both"
inject "$A@$DOMAIN, $B@$DOMAIN" "$A@$DOMAIN,$B@$DOMAIN" "$S_BOTH"
visible "$A" "$S_BOTH" "mail to both is visible to alice"
visible "$B" "$S_BOTH" "mail to both is visible to bob"
BOTH_ID=$(subject_id "$B" "$S_BOTH")
expect "bob deletes the shared message -> 200" "$(call "$B" "/api/messages/$BOTH_ID" DELETE)" 200
expect "deleted message is gone from bob's list" "$(subject_count "$B" "$S_BOTH")" 0
expect "deleted message is still in alice's list" "$(subject_count "$A" "$S_BOTH")" 1
expect "deleted message is 404 for bob" "$(call "$B" "/api/messages/$BOTH_ID")" 404
expect "deleted message still exists in Mailpit" "$(mp_count "$S_BOTH")" 1

S_BCC="isolation-$RUN envelope-only-both"
inject "public-list@example.com" "$A@$DOMAIN,$B@$DOMAIN" "$S_BCC"
visible "$A" "$S_BCC" "envelope-only mail to both is visible to alice"
BCC_ID=$(subject_id "$A" "$S_BCC")
call "$A" "/api/messages/$BCC_ID" > /dev/null
expect "message view does not expose bob's address to alice" "$(grep -c "$B@" "$TMP/out.json")" 0
call "$A" "/api/messages/$BCC_ID/raw" > /dev/null
expect "raw source does not expose bob's address to alice" "$(grep -c "$B@" "$TMP/out.json")" 0
expect "raw source has no Bcc header for alice" "$(grep -ci '^Bcc:' "$TMP/out.json")" 0
call "$A" "/api/messages/$BCC_ID/headers" > /dev/null
expect "headers do not expose bob's address to alice" "$(grep -c "$B@" "$TMP/out.json")" 0
expect "headers have no Bcc entry for alice" "$(jq 'keys | map(ascii_downcase) | index("bcc")' "$TMP/out.json")" null

P=plus-$RUN
S_PB="isolation-$RUN plus-base"; S_P1="isolation-$RUN plus-one"; S_P2="isolation-$RUN plus-two"; S_P10="isolation-$RUN plus-ten"; S_P1X="isolation-$RUN plus-one-sub"; S_P12="isolation-$RUN plus-one-and-two"
expect "open a base name -> 200" "$(open_inbox "$P")" 200
for tag in 1 2 10; do
  expect "open $P+$tag -> 200" "$(open_inbox "$P+$tag")" 200
  expect "$P+$tag is a new account" "$(jq -r .created "$TMP/out.json")" true
done
expect "opening a +tag name sets a session cookie" "$(has_cookie "$P+1")" yes
expect "me returns the +tag username as active" "$(call "$P+1" /api/me > /dev/null; jq -r .active "$TMP/out.json")" "$P+1"
expect "me returns the +tag address" "$(jq -r .address "$TMP/out.json")" "$P+1@$DOMAIN"
expect "a +tag name opened again reports created:false" "$(open_inbox "$P+1" again-plus > /dev/null; jq -r .created "$TMP/out.json")" false

inject "$P@$DOMAIN" "$P@$DOMAIN" "$S_PB"
inject "$P+1@$DOMAIN" "$P+1@$DOMAIN" "$S_P1"
inject "$P+2@$DOMAIN" "$P+2@$DOMAIN" "$S_P2"
inject "$P+10@$DOMAIN" "$P+10@$DOMAIN" "$S_P10"
inject "$P+1+x@$DOMAIN" "$P+1+x@$DOMAIN" "$S_P1X"
inject "$P+1@$DOMAIN, $P+2@$DOMAIN" "$P+1@$DOMAIN,$P+2@$DOMAIN" "$S_P12"
visible "$P+1" "$S_P1" "mail to name+1@ is visible to name+1"
visible "$P+1" "$S_P1X" "mail to name+1+x@ is visible to name+1"
visible "$P+1" "$S_P12" "mail to name+1@ and name+2@ is visible to name+1"
invisible "$P+1" "$S_PB" "mail to name@ is invisible to name+1"
invisible "$P+1" "$S_P2" "mail to name+2@ is invisible to name+1"
invisible "$P+1" "$S_P10" "mail to name+10@ is invisible to name+1"
visible "$P+2" "$S_P2" "mail to name+2@ is visible to name+2"
visible "$P+2" "$S_P12" "mail to name+1@ and name+2@ is visible to name+2"
invisible "$P+2" "$S_P1" "mail to name+1@ is invisible to name+2"
invisible "$P+2" "$S_P1X" "mail to name+1+x@ is invisible to name+2"
invisible "$P+2" "$S_P10" "mail to name+10@ is invisible to name+2"
visible "$P+10" "$S_P10" "mail to name+10@ is visible to name+10"
invisible "$P+10" "$S_P1" "mail to name+1@ is invisible to name+10"
invisible "$P+10" "$S_P1X" "mail to name+1+x@ is invisible to name+10"
invisible "$P+10" "$S_P12" "mail to name+1@ and name+2@ is invisible to name+10"
for subj in "$S_PB" "$S_P1" "$S_P2" "$S_P10" "$S_P1X" "$S_P12"; do
  visible "$P" "$subj" "the base name sees ${subj#isolation-$RUN }"
done

P1_ID=$(subject_id "$P+1" "$S_P1")
P2_ID=$(subject_id "$P+2" "$S_P2")
PB_ID=$(subject_id "$P" "$S_PB")
expect "name+1 reads its own message -> 200" "$(call "$P+1" "/api/messages/$P1_ID")" 200
expect "the base name reads a +tag message -> 200" "$(call "$P" "/api/messages/$P1_ID")" 200
expect_one_of "name+1 on name+2's message -> 403 or 404" "$(call "$P+1" "/api/messages/$P2_ID")" "403 404"
expect_one_of "name+1 on the base name's message -> 403 or 404" "$(call "$P+1" "/api/messages/$PB_ID")" "403 404"
expect_one_of "name+1 raw source of name+2's message -> 403 or 404" "$(call "$P+1" "/api/messages/$P2_ID/raw")" "403 404"
expect_one_of "name+1 delete of name+2's message -> 403 or 404" "$(call "$P+1" "/api/messages/$P2_ID" DELETE)" "403 404"
expect "name+2's message survives name+1's delete attempt" "$(subject_count "$P+2" "$S_P2")" 1

PLUS_COOKIE=$(cookie_of "$P+1")
expect "+tag session cookie value is URL-safe (no +, %, space)" "$(printf '%s' "$PLUS_COOKIE" | grep -cE '^v3\.[A-Za-z0-9_-]{43}\.[0-9]+\.[0-9a-f]{64}$')" 1
expect "the cookie carries no address name" "$(printf '%s' "$PLUS_COOKIE" | grep -c "$P")" 0
expect "+tag cookie sent as the only cookie -> 200" "$(status_with_cookie "inboxes=$PLUS_COOKIE" /api/me)" 200
expect "+tag cookie sent after another cookie -> 200" "$(status_with_cookie "theme=dark; inboxes=$PLUS_COOKIE" /api/me)" 200
expect "+tag cookie keeps name+1 active" "$(curl -s -H "Cookie: theme=dark; inboxes=$PLUS_COOKIE" "$INBOX/api/me" | jq -r .active)" "$P+1"
PLUS_TAMPERED="${PLUS_COOKIE%?}$([ "${PLUS_COOKIE: -1}" = "0" ] && echo 1 || echo 0)"
expect "tampered +tag cookie -> 401" "$(status_with_cookie "inboxes=$PLUS_TAMPERED")" 401
expect "name+1 signature under name+2's session id -> 401" "$(status_with_cookie "inboxes=v3.$(sid_of "$P+2").$(tail_of "$P+1")")" 401

PM=plusmulti-$RUN
expect "open the base name into a fresh browser -> 200" "$(open_inbox "$P" "$PM")" 200
expect "open name+1 into the same browser -> 200" "$(open_inbox "$P+1" "$PM")" 200
call "$PM" /api/me > /dev/null
expect "me lists the base and the +tag name with the +tag active" "$(jq -c '[.accounts, .active]' "$TMP/out.json")" "[[\"$P\",\"$P+1\"],\"$P+1\"]"
expect "active name+1 does not see name+2's mail" "$(subject_count "$PM" "$S_P2")" 0
expect "switch to the base name -> 200" "$(post /api/switch "{\"username\":\"$P\"}" "$PM")" 200
expect "after the switch the base name sees name+2's mail" "$(subject_count "$PM" "$S_P2")" 1
expect "switch to name+2 that is not in the cookie -> 403" "$(post /api/switch "{\"username\":\"$P+2\"}" "$PM")" 403
expect "forget name+1 -> 200" "$(post /api/forget "{\"username\":\"$P+1\"}" "$PM")" 200
expect "switching to the forgotten name+1 -> 403" "$(post /api/switch "{\"username\":\"$P+1\"}" "$PM")" 403

OTHER="other-$RUN"
open_inbox "$OTHER" > /dev/null
M="multi-$RUN"
expect "open alice into a fresh browser -> 200" "$(open_inbox "$A" "$M")" 200
expect "open bob into the same browser -> 200" "$(open_inbox "$B" "$M")" 200
call "$M" /api/me > /dev/null
expect "me lists both addresses with bob active" "$(jq -c '[.accounts, .active]' "$TMP/out.json")" "[[\"$A\",\"$B\"],\"$B\"]"
expect "active bob sees bob's mail" "$(subject_count "$M" "$S_BOB")" 1
expect "active bob does not see alice's mail" "$(subject_count "$M" "$S_OWN")" 0
BOTH_SID=$(sid_of "$M")
expect "switch to alice -> 200" "$(post /api/switch "{\"username\":\"$A\"}" "$M")" 200
expect "after the switch alice's mail is listed" "$(subject_count "$M" "$S_OWN")" 1
expect "after the switch bob's mail is not listed" "$(subject_count "$M" "$S_BOB")" 0
expect "switch to an existing name that is not in the cookie -> 403" "$(post /api/switch "{\"username\":\"$OTHER\"}" "$M")" 403
expect "switch to an unknown name -> 403" "$(post /api/switch "{\"username\":\"ghost-$RUN\"}" "$M")" 403
expect "switch without a cookie -> 401" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d "{\"username\":\"$A\"}" "$INBOX/api/switch")" 401
expect "rejected switches leave alice active" "$(subject_count "$M" "$S_BOB")" 0
expect "switching keeps the same session id" "$(sid_of "$M")" "$BOTH_SID"
expect "forget bob -> 200" "$(post /api/forget "{\"username\":\"$B\"}" "$M")" 200
call "$M" /api/me > /dev/null
expect "me no longer lists bob" "$(jq -c .accounts "$TMP/out.json")" "[\"$A\"]"
expect "switching to the forgotten bob -> 403" "$(post /api/switch "{\"username\":\"$B\"}" "$M")" 403
expect_one_of "bob's message with the remaining cookie -> 403 or 404" "$(call "$M" "/api/messages/$B_ID")" "403 404"
expect "forget of a name that is not listed -> 403" "$(post /api/forget "{\"username\":\"$OTHER\"}" "$M")" 403
expect "forget the last address -> 200" "$(post /api/forget "{\"username\":\"$A\"}" "$M")" 200
expect "after forgetting every address reads are refused -> 401" "$(call "$M" /api/messages)" 401
open_inbox "$B" "$M" > /dev/null
expect "forgetting never deletes the server account (opens as existing)" "$(jq -r .created "$TMP/out.json")" false

LEGACY_IAT=$(date +%s)
LEGACY_SIG=$(printf 'session:%s.%s' "$A" "$LEGACY_IAT" | openssl dgst -sha256 -hmac "$INBOX_KEY" -r | cut -d' ' -f1)
expect "old single-user cookie still works -> 200" "$(curl -s -o "$TMP/out.json" -w '%{http_code}' -H "Cookie: inbox=$A.$LEGACY_IAT.$LEGACY_SIG" "$INBOX/api/me")" 200
expect "old cookie becomes a one-item list" "$(jq -c '[.accounts, .active]' "$TMP/out.json")" "[[\"$A\"],\"$A\"]"
expect "old cookie reads alice's mail" "$(curl -s -H "Cookie: inbox=$A.$LEGACY_IAT.$LEGACY_SIG" "$INBOX/api/messages" | jq --arg s "$S_OWN" '[.messages[] | select(.subject == $s)] | length')" 1
expect "old cookie signed for another name -> 401" "$(status_with_cookie "inbox=$B.$LEGACY_IAT.$LEGACY_SIG")" 401

expect "old cookie reply sets a session cookie in the new format" "$(curl -s -D - -o /dev/null -H "Cookie: inbox=$A.$LEGACY_IAT.$LEGACY_SIG" "$INBOX/api/me" | grep -ci '^set-cookie: inboxes=v3\.')" 1

v2_cookie() {
  local payload iat
  payload=$(printf '{"accounts":[%s],"active":"%s"}' "$1" "$2" | openssl base64 -A | tr '+/' '-_' | tr -d '=')
  iat=$(date +%s)
  echo "$payload.$iat.$(printf 'v2:%s.%s' "$payload" "$iat" | openssl dgst -sha256 -hmac "$INBOX_KEY" -r | cut -d' ' -f1)"
}
IP_V2=$(rand_ip)
V2_NAMES=(); V2_JSON=""
for i in $(seq 1 10); do
  V2_NAMES+=("v2m-$RUN-$i")
  V2_JSON="$V2_JSON${V2_JSON:+,}\"v2m-$RUN-$i\""
  open_inbox "v2m-$RUN-$i" "v2seed" "$IP_V2" > /dev/null
done
V2_COOKIE=$(v2_cookie "$V2_JSON" "v2m-$RUN-4")
curl -s -D "$TMP/v2.headers" -o "$TMP/out.json" -H "Cookie: inboxes=$V2_COOKIE" "$INBOX/api/me"
expect "a current v2 cookie with 10 names keeps the same list in order" "$(jq -c .accounts "$TMP/out.json")" "$(printf '%s\n' "${V2_NAMES[@]}" | jq -R . | jq -sc .)"
expect "a current v2 cookie keeps its active address" "$(jq -r .active "$TMP/out.json")" "v2m-$RUN-4"
V3_COOKIE=$(grep -i '^set-cookie: inboxes=' "$TMP/v2.headers" | sed 's/^[^=]*=//; s/;.*//' | tr -d '[:cntrl:]')
expect "migration reissues the cookie in the new format" "$(printf '%s' "$V3_COOKIE" | grep -cE '^v3\.[A-Za-z0-9_-]{43}\.[0-9]+\.[0-9a-f]{64}$')" 1
curl -s -o "$TMP/out.json" -H "Cookie: inboxes=$V3_COOKIE" "$INBOX/api/me"
expect "the reissued cookie reads back the 10 names" "$(jq '.accounts | length' "$TMP/out.json")" 10
expect "the reissued cookie reads back the active address" "$(jq -r .active "$TMP/out.json")" "v2m-$RUN-4"
expect "the migrated cookie stays short" "$([ ${#V3_COOKIE} -lt 200 ] && echo short || echo long)" short
expect "a v2 cookie with a bad signature does not migrate -> 401" "$(status_with_cookie "inboxes=${V2_COOKIE%?}$([ "${V2_COOKIE: -1}" = "0" ] && echo 1 || echo 0)")" 401
expect "a v2 cookie naming an unknown address does not migrate -> 401" "$(status_with_cookie "inboxes=$(v2_cookie "\"ghost-$RUN\"" "ghost-$RUN")")" 401

UNL="unl-$RUN"
codes=""
for i in $(seq 1 150); do
  codes="$codes $(open_inbox "unl-$RUN-$i" "$UNL" "$(rand_ip)")"
  case $i in 1|10|150) printf '%s' "$(cookie_of "$UNL")" | wc -c | tr -d ' ' > "$TMP/len-$i";; esac
done
expect "150 addresses fit in one browser" "$(echo $codes | tr ' ' '\n' | sort -u | tr '\n' ' ')" "200 "
call "$UNL" /api/me > /dev/null
expect "me lists all 150 addresses" "$(jq '.accounts | length' "$TMP/out.json")" 150
expect "the 150 addresses keep their order" "$(jq -r '[.accounts[0], .accounts[74], .accounts[149]] | join(",")' "$TMP/out.json" | tr -d '[:cntrl:]')" "unl-$RUN-1,unl-$RUN-75,unl-$RUN-150"
expect "the last opened address is active" "$(jq -r .active "$TMP/out.json")" "unl-$RUN-150"
expect "the cookie has the same length with 1, 10 and 150 addresses" "$(cat "$TMP/len-1" "$TMP/len-10" "$TMP/len-150" | sort -u | wc -l | tr -d ' ')" 1
echo "INFO  cookie value length with 1, 10 and 150 addresses: $(cat "$TMP/len-1") $(cat "$TMP/len-10") $(cat "$TMP/len-150")"
expect "switch to the 20th address of 150 -> 200" "$(post /api/switch "{\"username\":\"unl-$RUN-20\"}" "$UNL")" 200
expect "forget the 75th address of 150 -> 200" "$(post /api/forget "{\"username\":\"unl-$RUN-75\"}" "$UNL")" 200
call "$UNL" /api/me > /dev/null
expect "149 addresses remain and the switched one is active" "$(jq -c '[(.accounts | length), .active]' "$TMP/out.json")" "[149,\"unl-$RUN-20\"]"
expect "a new browser still sees none of them" "$(curl -s -o /dev/null -w '%{http_code}' "$INBOX/api/me")" 401

expect "GET /api/random -> 200" "$(curl -s -o "$TMP/out.json" -w '%{http_code}' "$INBOX/api/random")" 200
RANDOM_NAME=$(jq -r .username "$TMP/out.json" | tr -d '[:cntrl:]')
RANDOM_NAMES="$RANDOM_NAMES $RANDOM_NAME"
expect "random name matches rand-xxxxxx" "$(printf '%s' "$RANDOM_NAME" | grep -cE '^rand-[a-z0-9]{6}$')" 1
open_inbox "$RANDOM_NAME" random-open > /dev/null
expect "random name opens as a new inbox" "$(jq -r .created "$TMP/out.json")" true

IP_RANDOM=$(rand_ip)
codes=""; names=""
for i in $(seq 1 30); do
  codes="$codes $(curl -s -o "$TMP/r$i.json" -w '%{http_code}' -H "CF-Connecting-IP: $IP_RANDOM" "$INBOX/api/random")"
  names="$names $(jq -r .username "$TMP/r$i.json" | tr -d '[:cntrl:]')"
done
expect "30 random requests from one IP all succeed" "$(echo $codes | tr ' ' '\n' | sort -u | tr '\n' ' ')" "200 "
expect "30 random names are unique" "$(echo $names | tr ' ' '\n' | sort -u | wc -l | tr -d ' ')" 30
expect "30 random names all match rand-xxxxxx" "$(echo $names | tr ' ' '\n' | grep -cE '^rand-[a-z0-9]{6}$')" 30
USED=$($COMPOSE exec -T inbox node --disable-warning=ExperimentalWarning -e "
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync('/data/users.sqlite');
  const names = '$names'.split(' ').filter(Boolean);
  console.log(names.filter((n) => db.prepare('SELECT 1 FROM users WHERE username = ?').get(n)).length)" 2>/dev/null | tr -d '[:cntrl:]')
expect "none of the random names exists on the server" "$USED" 0
expect "31st random request from one IP -> 429" "$(curl -s -o "$TMP/out.json" -w '%{http_code}' -H "CF-Connecting-IP: $IP_RANDOM" "$INBOX/api/random")" 429
expect "429 carries a readable message" "$(jq -r .error "$TMP/out.json" | grep -c 'try again')" 1
expect "another IP is not limited on /api/random" "$(curl -s -o /dev/null -w '%{http_code}' -H "CF-Connecting-IP: $(rand_ip)" "$INBOX/api/random")" 200

codes=""
for i in $(seq 1 30); do codes="$codes $(open_inbox "lim-$RUN-$i" "lim$i" "$IP_LIMIT")"; done
expect "30 new usernames from one IP all succeed" "$(echo $codes | tr ' ' '
' | sort -u | tr '
' ' ')" "200 "
expect "31st new username from one IP within an hour -> 429" "$(open_inbox "lim-$RUN-31" lim31 "$IP_LIMIT")" 429
expect "an existing username still opens from the limited IP -> 200" "$(open_inbox "$A" limited-existing "$IP_LIMIT")" 200
expect "existing username from the limited IP reports created:false" "$(jq -r .created "$TMP/out.json")" false

expect "GET 127.0.0.1:8025/admin/ with no auth -> 401" "$(curl -s -o /dev/null -w '%{http_code}' "$MAILPIT/admin/")" 401
expect "GET 127.0.0.1:8025/admin/ as root -> 200" "$(curl -s -o /dev/null -w '%{http_code}' -u "$ROOT_AUTH" "$MAILPIT/admin/")" 200
expect "GET 127.0.0.1:8025/admin/ as $MP_USER -> 200" "$(curl -s -o /dev/null -w '%{http_code}' -u "$MP_AUTH" "$MAILPIT/admin/")" 200
expect "GET /admin/api/v1/info as the ci user -> 200" "$(curl -s -o /dev/null -w '%{http_code}' -u "$CI_AUTH" "$MAILPIT/admin/api/v1/info")" 200
expect "GET /admin/api/v1/info as ci with a wrong password -> 401" "$(curl -s -o /dev/null -w '%{http_code}' -u "${CI_AUTH%%:*}:wrong-password" "$MAILPIT/admin/api/v1/info")" 401
code=$(curl -s -o /dev/null -w '%{http_code}' -u "$MP_AUTH" "$MAILPIT/api/v1/info")
[ "$code" != "200" ] && pass "GET 127.0.0.1:8025/api/v1/info (old path) is not 200 (got $code)" || fail "old Mailpit API path" "got 200"

timeout 90 node inbox/test/refresh-cooldown.mjs "refresh-$RUN" > "$TMP/refresh.txt" 2>&1
REFRESH_RC=$?
grep '^PASS\|^FAIL' "$TMP/refresh.txt" | sed 's/^\(PASS\|FAIL\)  /\1  refresh button: /'
FAILS=$((FAILS + $(grep -c '^FAIL' "$TMP/refresh.txt")))
[ "$REFRESH_RC" = "0" ] || { fail "refresh button check" "script exited $REFRESH_RC"; head -c 600 "$TMP/refresh.txt"; }
timeout 120 node inbox/test/accounts.mjs "$A" "$B" "$S_OWN" "$S_BOB" ${SHOT_DIR:-} > "$TMP/accounts.txt" 2>&1
ACCOUNTS_RC=$?
grep '^PASS\|^FAIL' "$TMP/accounts.txt" | sed 's/^\(PASS\|FAIL\)  /\1  browser: /'
FAILS=$((FAILS + $(grep -c '^FAIL' "$TMP/accounts.txt")))
BROWSER_RANDOM=$(grep '^INFO  random-name ' "$TMP/accounts.txt" | cut -d' ' -f4 | tr -d '[:cntrl:]')
RANDOM_NAMES="$RANDOM_NAMES $BROWSER_RANDOM"
[ "$ACCOUNTS_RC" = "0" ] || { fail "browser account checks" "script exited $ACCOUNTS_RC"; head -c 600 "$TMP/accounts.txt"; }
timeout 120 node inbox/test/modal.mjs "$P" "$P+1" "$S_PB" "$S_P1" "$S_P2" > "$TMP/modal.txt" 2>&1
MODAL_RC=$?
grep '^PASS\|^FAIL' "$TMP/modal.txt" | sed 's/^\(PASS\|FAIL\)  /\1  modal: /'
FAILS=$((FAILS + $(grep -c '^FAIL' "$TMP/modal.txt")))
[ "$MODAL_RC" = "0" ] || { fail "modal and spotlight checks" "script exited $MODAL_RC"; head -c 600 "$TMP/modal.txt"; }
timeout 180 node inbox/test/many.mjs "$UNL" 150 "many-extra-$RUN" > "$TMP/many.txt" 2>&1
MANY_RC=$?
grep '^PASS\|^FAIL' "$TMP/many.txt" | sed 's/^\(PASS\|FAIL\)  /\1  many addresses: /'
grep '^INFO' "$TMP/many.txt"
FAILS=$((FAILS + $(grep -c '^FAIL' "$TMP/many.txt")))
[ "$MANY_RC" = "0" ] || { fail "many-address browser checks" "script exited $MANY_RC"; head -c 600 "$TMP/many.txt"; }
timeout 240 node inbox/test/filters.mjs "filters-$RUN" ${SHOT_DIR:-} > "$TMP/filters.txt" 2>&1
FILTERS_RC=$?
grep '^PASS\|^FAIL' "$TMP/filters.txt" | sed 's/^\(PASS\|FAIL\)  /\1  list sort and filter: /'
FAILS=$((FAILS + $(grep -c '^FAIL' "$TMP/filters.txt")))
[ "$FILTERS_RC" = "0" ] || { fail "list sort and filter checks" "script exited $FILTERS_RC"; head -c 600 "$TMP/filters.txt"; }
expect "no Thai text in the served UI files" "$(LC_ALL=C.UTF-8 grep -rlIP '[\x{0E00}-\x{0E7F}]' inbox/src | wc -l | tr -d ' ')" 0
expect "GET /api/status without a cookie -> 200" "$(curl -s -o "$TMP/status.json" -w '%{http_code}' "$INBOX/api/status")" 200
expect "status reports mailpit and bridge ok" "$(jq -c '[.mailpit, .bridge]' "$TMP/status.json")" '["ok","ok"]'
expect "status carries a checkedAt timestamp" "$(jq -r '.checkedAt | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T")' "$TMP/status.json")" true
expect "status exposes nothing but mailpit, bridge and checkedAt" "$(jq -c 'keys' "$TMP/status.json")" '["bridge","checkedAt","mailpit"]'
expect "/index.html serves the page like / (the edge worker routes both)" "$(curl -s -o /dev/null -w '%{http_code}' "$INBOX/index.html")" 200
expect "vendored stylesheet is served without auth" "$(curl -s -o /dev/null -w '%{http_code}' "$INBOX/vendor/app.css")" 200
expect "/listview.js is served without auth as JavaScript" "$(curl -s -o /dev/null -w '%{http_code} %{content_type}' "$INBOX/listview.js" | tr -d '\r')" "200 text/javascript; charset=utf-8"
expect "the message list reports truncated:false for a small inbox" "$(call "$A" /api/messages > /dev/null; jq -r .truncated "$TMP/out.json")" false
expect "unknown vendor path -> 404" "$(curl -s -o /dev/null -w '%{http_code}' "$INBOX/vendor/nope.js")" 404
expect "docker compose port inbox 8090" "$($COMPOSE port inbox 8090 | tr -d '\r')" "127.0.0.1:${INBOX_HOST_PORT:-8090}"
