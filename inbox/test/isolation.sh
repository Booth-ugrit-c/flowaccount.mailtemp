#!/usr/bin/env bash
set -u
cd "$(dirname "$0")/../.."

INBOX=${INBOX_URL:-http://127.0.0.1:8090}
BRIDGE=${BRIDGE_URL:-http://127.0.0.1:8080/ingest}
MAILPIT=${MAILPIT_URL:-http://127.0.0.1:8025}
COMPOSE="docker compose"
DOMAIN=booth.pp.ua
envv() { grep -m1 "^$1=" .env | cut -d= -f2- | tr -d '[:cntrl:]'; }
HMAC_KEY=$(envv HMAC_KEY)
INBOX_KEY=$(grep -m1 "^INBOX_KEY=" secrets/inbox.env | cut -d= -f2- | tr -d "[:cntrl:]")
MP_USER=$(envv MAILPIT_UI_USER)
MP_AUTH="$MP_USER:$(envv MAILPIT_UI_PASSWORD)"
ROOT_AUTH="root:$(grep -m1 "^root:" secrets/ui_auth | cut -d: -f2- | tr -d "[:cntrl:]")"

RUN=$(openssl rand -hex 4)
TMP=$(mktemp -d)
rand_ip() { echo "10.$((RANDOM % 250 + 1)).$((RANDOM % 250 + 1)).$((RANDOM % 250 + 1))"; }
IP_MAIN=$(rand_ip); IP_LIMIT=$(rand_ip); IP_CAP=$(rand_ip)
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
      removed += Number(db.prepare('DELETE FROM users WHERE username LIKE ?').run(name).changes);
    }
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

for name in qa qa1 h13x root admin postmaster ab "Bad Name" "$A+tag" "$A@booth.pp.ua"; do
  expect "open '$name' -> 400" "$(open_inbox "$name" bad)" 400
done
expect "reserved name sets no cookie" "$(has_cookie bad)" no
expect "open with a form content type -> 415" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -d "username=form-$RUN" "$INBOX/api/open")" 415

expect "no cookie on /api/messages -> 401" "$(call nobody /api/messages)" 401
cookie_of() { awk -F'	' '$6 == "inboxes" {print $7}' "$TMP/$1.jar" | tr -d '[:cntrl:]'; }
status_with_cookie() { curl -s -o /dev/null -w '%{http_code}' -H "Cookie: $1" "$INBOX${2:-/api/messages}"; }
COOKIE=$(cookie_of "$A")
TAMPERED="${COOKIE%?}$([ "${COOKIE: -1}" = "0" ] && echo 1 || echo 0)"
expect "tampered cookie on /api/messages -> 401" "$(status_with_cookie "inboxes=$TAMPERED")" 401
expect "alice's signature under bob's payload -> 401" "$(status_with_cookie "inboxes=$(cookie_of "$B" | cut -d. -f1).${COOKIE#*.}")" 401
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

OTHER="other-$RUN"
open_inbox "$OTHER" > /dev/null
M="multi-$RUN"
expect "open alice into a fresh browser -> 200" "$(open_inbox "$A" "$M")" 200
expect "open bob into the same browser -> 200" "$(open_inbox "$B" "$M")" 200
call "$M" /api/me > /dev/null
expect "me lists both addresses with bob active" "$(jq -c '[.accounts, .active]' "$TMP/out.json")" "[[\"$A\",\"$B\"],\"$B\"]"
expect "active bob sees bob's mail" "$(subject_count "$M" "$S_BOB")" 1
expect "active bob does not see alice's mail" "$(subject_count "$M" "$S_OWN")" 0
BOTH_COOKIE=$(cookie_of "$M")
expect "switch to alice -> 200" "$(post /api/switch "{\"username\":\"$A\"}" "$M")" 200
expect "after the switch alice's mail is listed" "$(subject_count "$M" "$S_OWN")" 1
expect "after the switch bob's mail is not listed" "$(subject_count "$M" "$S_BOB")" 0
expect "switch to an existing name that is not in the cookie -> 403" "$(post /api/switch "{\"username\":\"$OTHER\"}" "$M")" 403
expect "switch to an unknown name -> 403" "$(post /api/switch "{\"username\":\"ghost-$RUN\"}" "$M")" 403
expect "switch without a cookie -> 401" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d "{\"username\":\"$A\"}" "$INBOX/api/switch")" 401
expect "rejected switches leave alice active" "$(subject_count "$M" "$S_BOB")" 0
ALICE_ACTIVE_COOKIE=$(cookie_of "$M")
expect "payload forced to active bob under alice's signature -> 401" "$(status_with_cookie "inboxes=${BOTH_COOKIE%%.*}.${ALICE_ACTIVE_COOKIE#*.}")" 401
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

CAP="cap-$RUN"
codes=""
for i in $(seq 1 10); do codes="$codes $(open_inbox "cap-$RUN-$i" "$CAP" "$IP_CAP")"; done
expect "10 addresses fit in one browser" "$(echo $codes | tr ' ' '\n' | sort -u | tr '\n' ' ')" "200 "
expect "11th address in one browser -> 400" "$(open_inbox "cap-$RUN-11" "$CAP" "$IP_CAP")" 400
open_inbox "cap-$RUN-11" cap-check "$IP_CAP" > /dev/null
expect "rejected 11th name was not created on the server" "$(jq -r .created "$TMP/out.json")" true

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
expect "no Thai text in the served UI files" "$(LC_ALL=C.UTF-8 grep -rlIP '[\x{0E00}-\x{0E7F}]' inbox/src | wc -l | tr -d ' ')" 0
expect "vendored stylesheet is served without auth" "$(curl -s -o /dev/null -w '%{http_code}' "$INBOX/vendor/app.css")" 200
expect "unknown vendor path -> 404" "$(curl -s -o /dev/null -w '%{http_code}' "$INBOX/vendor/nope.js")" 404
expect "docker compose port inbox 8090" "$($COMPOSE port inbox 8090 | tr -d '\r')" "127.0.0.1:${INBOX_HOST_PORT:-8090}"
