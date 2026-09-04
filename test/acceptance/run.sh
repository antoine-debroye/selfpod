#!/usr/bin/env bash
# SelfPod acceptance checklist (spec §17), run against a real container.
#
# Every item here corresponds to a failure the hand-rolled version of this app
# actually hit, so these are checked end to end against a built image rather than
# in unit tests: the point is to prove the behaviour survives Docker, the
# entrypoint, the permission model and real HTTP.
#
#   ./test/acceptance/run.sh [image]      # default image: selfpod:test
#
# Requires: docker, curl, python3.

set -uo pipefail

IMAGE="${1:-selfpod:test}"
PORT="${PORT:-8199}"
BASE="http://localhost:${PORT}"
WORK="$(mktemp -d)"
JAR="${WORK}/cookies"
NAME="selfpod-acceptance-$$"
FIXTURES="$(cd "$(dirname "$0")/../fixtures/audio" && pwd)"
PASS=0
FAIL=0

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  \033[31m✗ %s\033[0m\n' "$1"; FAIL=$((FAIL + 1)); }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker rm -f "${NAME}-feed" >/dev/null 2>&1 || true
  docker network rm "${NAME}-net" >/dev/null 2>&1 || true
  docker volume rm "${NAME}-locked" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

api() { curl -s -b "$JAR" -H 'Sec-Fetch-Site: same-origin' "$@"; }
json() { python3 -c "import json,sys; $1"; }

wait_for_health() {
  for _ in $(seq 1 40); do
    curl -sf "${BASE}/health" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

# Waits for the watcher (or the fallback rescan) to notice a filesystem change.
wait_for_scan() { sleep "${1:-9}"; }

# Polls a condition once a second until it holds, or gives up after `seconds`.
#
# Whether a change reaches SelfPod through the watcher or only through the next
# scheduled rescan depends on the mount: a Docker Desktop bind mount and an SMB
# share each deliver some events and swallow others, which is the entire reason
# the periodic rescan exists. Anything downstream of "SelfPod noticed" therefore
# has to wait for the state the app reports, not for a duration someone guessed.
wait_until() {
  local deadline=$((SECONDS + $1))
  shift
  while ! "$@"; do
    [ "$SECONDS" -ge "$deadline" ] && return 1
    sleep 1
  done
  return 0
}

step "Starting ${IMAGE} with a fresh data directory"
mkdir -p "${WORK}/data/shows/tape-club"
docker run -d --name "$NAME" -p "${PORT}:8080" \
  -v "${WORK}/data:/data" \
  -e PUBLIC_BASE_URL="$BASE" \
  -e ADMIN_PASSWORD=acceptance-password \
  -e RESCAN_INTERVAL_SECONDS=60 \
  -e TZ=Europe/London \
  "$IMAGE" >/dev/null
wait_for_health && pass "container is healthy" || { fail "container never became healthy"; docker logs "$NAME"; exit 1; }

curl -s -c "$JAR" -X POST "${BASE}/api/login" \
  -H 'Content-Type: application/json' -H 'Sec-Fetch-Site: same-origin' \
  -d '{"username":"admin","password":"acceptance-password"}' >/dev/null

TOKEN=""
SHOW_ID=""
refresh_show() {
  local body
  body="$(api "${BASE}/api/shows")"
  TOKEN="$(printf '%s' "$body" | json 'd=json.load(sys.stdin); print(d["shows"][0]["feedToken"] if d["shows"] else "")' 2>/dev/null)"
  SHOW_ID="$(printf '%s' "$body" | json 'd=json.load(sys.stdin); print(d["shows"][0]["id"] if d["shows"] else "")' 2>/dev/null)"
}
feed() { curl -s "${BASE}/feeds/tape-club/${TOKEN}.xml"; }
feed_items() { feed | grep -c '<item>'; }
feed_is_empty() { [ "$(feed_items)" = "0" ]; }
episode_status() {
  api "${BASE}/api/shows/${SHOW_ID}/episodes" \
    | json 'd=json.load(sys.stdin); print(d["episodes"][0]["status"] if d["episodes"] else "")' 2>/dev/null
}
episode_is() { [ "$(episode_status)" = "$1" ]; }

# --------------------------------------------------------------------------- 1
step "1. Dropping an .m4a in appears in the feed with type=audio/x-m4a, no restart"
NASTY="ep 42 🎙️ – it's ‘live’.m4a"
cp "${FIXTURES}/sample.m4a" "${WORK}/data/shows/tape-club/${NASTY}"
wait_for_scan
refresh_show
if [ -z "$TOKEN" ]; then
  fail "the show folder was never discovered"
else
  pass "folder became a show with no configuration"
  feed | grep -q 'type="audio/x-m4a"' && pass 'enclosure carries type="audio/x-m4a"' || fail "wrong or missing MIME type"
fi

# --------------------------------------------------------------------------- 2
step "2. A filename with spaces, an emoji and curly quotes is downloadable verbatim"
URL="$(feed | python3 -c 'import re,sys; m=re.search(r"<enclosure url=\"([^\"]+)\"", sys.stdin.read()); print(m.group(1).replace("&amp;","&") if m else "")')"
if [ -z "$URL" ]; then
  fail "no enclosure URL in the feed"
else
  curl -sf -o "${WORK}/download.m4a" "$URL" \
    && cmp -s "${WORK}/download.m4a" "${FIXTURES}/sample.m4a" \
    && pass "downloaded byte-identical audio from the published URL" \
    || fail "the published URL did not download correctly"
  code="$(curl -s -o /dev/null -w '%{http_code}' -H 'Range: bytes=0-99' "$URL")"
  [ "$code" = "206" ] && pass "HTTP Range returns 206 (seeking works)" || fail "Range request returned ${code}, expected 206"
fi

# --------------------------------------------------------------------------- 3
step "3. A cover saved as cover.png (not .jpg) is detected and served"
docker run --rm -v "${WORK}/data:/data" --entrypoint node "$IMAGE" -e \
  'require("sharp")({create:{width:1500,height:1500,channels:3,background:"#2A6F97"}}).png().toFile("/data/shows/tape-club/cover.png")' >/dev/null 2>&1
wait_for_scan
CT="$(curl -s -o /dev/null -D- "${BASE}/media/tape-club/${TOKEN}/cover.jpg" | awk 'tolower($1)=="content-type:"{print $2}' | tr -d '\r')"
[ "$CT" = "image/png" ] && pass "cover.png served through the stable cover.jpg URL" || fail "cover content type was '${CT}'"

# --------------------------------------------------------------------------- 4
step "4. Renaming a file changes its URL but not its GUID"
GUID_BEFORE="$(feed | python3 -c 'import re,sys; m=re.search(r"<guid[^>]*>([^<]+)</guid>", sys.stdin.read()); print(m.group(1) if m else "")')"
mv "${WORK}/data/shows/tape-club/${NASTY}" "${WORK}/data/shows/tape-club/completely-different-name.m4a"
wait_for_scan
GUID_AFTER="$(feed | python3 -c 'import re,sys; m=re.search(r"<guid[^>]*>([^<]+)</guid>", sys.stdin.read()); print(m.group(1) if m else "")')"
[ -n "$GUID_BEFORE" ] && [ "$GUID_BEFORE" = "$GUID_AFTER" ] \
  && pass "GUID survived the rename (subscribers keep their played state)" \
  || fail "GUID changed on rename: ${GUID_BEFORE} → ${GUID_AFTER}"
feed | grep -q 'completely-different-name.m4a' && pass "the feed points at the new filename" || fail "the feed still points at the old filename"

# --------------------------------------------------------------------------- 5
step "5. Editing a title, then rescanning, does not revert it"
EP_ID="$(api "${BASE}/api/shows/${SHOW_ID}/episodes" | json 'print(json.load(sys.stdin)["episodes"][0]["id"])')"
api -X PATCH "${BASE}/api/episodes/${EP_ID}" -H 'Content-Type: application/json' \
  -d '{"title":"My Hand-Written Title"}' >/dev/null
api -X POST "${BASE}/api/shows/${SHOW_ID}/rescan" >/dev/null
TITLE="$(api "${BASE}/api/episodes/${EP_ID}" | json 'print(json.load(sys.stdin)["episode"]["title"])')"
[ "$TITLE" = "My Hand-Written Title" ] && pass "the edited title survived a full rescan" || fail "title became '${TITLE}'"

# --------------------------------------------------------------------------- 6
step "6. Updating the cover is visible immediately (short cache, content ETag)"
ETAG_BEFORE="$(curl -s -o /dev/null -D- "${BASE}/media/tape-club/${TOKEN}/cover.jpg" | awk 'tolower($1)=="etag:"{print $2}' | tr -d '\r')"
docker run --rm -v "${WORK}/data:/data" --entrypoint node "$IMAGE" -e \
  'require("sharp")({create:{width:1500,height:1500,channels:3,background:"#4A8C5C"}}).png().toFile("/data/shows/tape-club/cover.png")' >/dev/null 2>&1
wait_for_scan
ETAG_AFTER="$(curl -s -o /dev/null -D- "${BASE}/media/tape-club/${TOKEN}/cover.jpg" | awk 'tolower($1)=="etag:"{print $2}' | tr -d '\r')"
[ -n "$ETAG_BEFORE" ] && [ "$ETAG_BEFORE" != "$ETAG_AFTER" ] \
  && pass "the new artwork is served straight away (ETag changed)" \
  || fail "artwork did not refresh (etag ${ETAG_BEFORE} → ${ETAG_AFTER})"
curl -s -o /dev/null -D- "${BASE}/media/tape-club/${TOKEN}/cover.jpg" | grep -qi 'cache-control: public, max-age=3600' \
  && pass "artwork uses a deliberately short cache lifetime" || fail "unexpected cache-control on artwork"

# --------------------------------------------------------------------------- 7
step "7. A vanished file stays in the feed, then drops after the grace period"
rm -f "${WORK}/data/shows/tape-club/completely-different-name.m4a"

# Wait for the episode to actually be marked missing rather than for a fixed few
# seconds. On a mount that delivers no unlink event — a Docker Desktop bind mount,
# and plenty of SMB shares — the deletion is noticed by the next scheduled rescan
# instead, up to a whole interval later. A sleep here proved nothing: the episode
# was still `active` when the grace period was backdated below, so that UPDATE
# matched no rows and the feed was only still holding the item because nothing had
# happened to it yet.
if ! wait_until 180 episode_is missing; then
  fail "the vanished file was never noticed at all (episode is '$(episode_status)')"
else
  ITEMS="$(feed_items)"
  [ "$ITEMS" = "1" ] && pass "a missing file does not immediately disappear from the feed" || fail "expected 1 item during grace, saw ${ITEMS}"

  # Shorten the grace period the way an owner would, through the API, and only then
  # fake the clock — and only where the sweep reads it. SelfPod has no way to be told
  # an episode has been missing for an hour, and waiting a real hour is not a test
  # anyone would run.
  GRACE_SET="$(api -X PATCH "${BASE}/api/settings" -H 'Content-Type: application/json' \
    -d '{"missingGraceSeconds":60}' | grep -c 'missing_grace_seconds')"
  BACKDATED="$(docker exec "$NAME" node -e '
const D = require("better-sqlite3");
const db = new D("/data/db.sqlite");
const result = db.prepare("UPDATE episodes SET missing_since=? WHERE status=?")
  .run(new Date(Date.now() - 3600e3).toISOString(), "missing");
console.log(result.changes);
' 2>&1 | tail -1)"

  # Both halves of the set-up have to have taken, or the sweep is being waited on for
  # a moment that never arrives and the failure would read as a bug in the sweep.
  if [ "$GRACE_SET" != "1" ]; then
    fail "the grace period could not be shortened through the API"
  elif [ "$BACKDATED" != "1" ]; then
    fail "could not backdate the missing mark (got '${BACKDATED}'), so the grace period was never reached"
  else
    # The sweep runs on a scheduler tick and nothing exposes it over HTTP, so this
    # waits for the next tick — up to one rescan interval away — and returns the
    # moment the feed drops rather than at some fixed time after it.
    printf '  … waiting for the scheduled sweep\n'
    wait_until 180 feed_is_empty \
      && pass "it dropped out of the feed once the grace period passed" \
      || fail "expected 0 items after grace, saw $(feed_items)"
  fi
fi

# --------------------------------------------------------------------------- 8
step "8. Adding more shows needs no change to the container configuration"
mkdir -p "${WORK}/data/shows/field-notes" "${WORK}/data/shows/static-hour"
cp "${FIXTURES}/sample.mp3" "${WORK}/data/shows/field-notes/"
cp "${FIXTURES}/sample.flac" "${WORK}/data/shows/static-hour/"
wait_for_scan
COUNT="$(api "${BASE}/api/shows" | json 'print(len(json.load(sys.stdin)["shows"]))')"
[ "$COUNT" = "3" ] && pass "three shows discovered; compose was written once and never edited" || fail "expected 3 shows, saw ${COUNT}"

# --------------------------------------------------------------------------- 9
step "9. A PUID without access produces a clear error in the logs AND the web UI"
docker volume create "${NAME}-locked" >/dev/null
docker run --rm -v "${NAME}-locked:/locked" alpine sh -c 'chown -R 4000:4000 /locked && chmod -R 700 /locked' >/dev/null
docker rm -f "${NAME}-perm" >/dev/null 2>&1
docker run -d --name "${NAME}-perm" -p "$((PORT + 1)):8080" \
  -v "${NAME}-locked:/locked" -e DATA_DIR=/locked -e PUID=1000 -e PGID=1000 \
  -e PUBLIC_BASE_URL="http://localhost:$((PORT + 1))" "$IMAGE" >/dev/null

# Waited for, not slept through. A fixed sleep here is a guess about how long a
# container takes to boot and write its first log line, and on a loaded machine the
# guess is wrong — which failed this check twice in a row while the app was behaving
# perfectly. A timing assumption that reports a fault in something else is worse than
# no check at all.
perm_log_explains() {
  docker logs "${NAME}-perm" 2>&1 | grep -qi 'CANNOT READ /locked as UID 1000'
}
if wait_until 60 perm_log_explains; then
  pass "the container log names the exact path and UID"
else
  fail "the log did not explain the permission problem"
fi
# And wait for it to be answering before asking it anything. The point of this step is
# that a permission fault stays *explainable* — the container keeps serving so the
# owner can read what went wrong — so "it had not finished starting" is not an answer
# to any of the checks below.
perm_http_up() { curl -sf "http://localhost:$((PORT + 1))/health" >/dev/null 2>&1; }
wait_until 60 perm_http_up || fail "the degraded container never started answering at all"

BODY="$(curl -s "http://localhost:$((PORT + 1))/")"
printf '%s' "$BODY" | grep -qi "database" && printf '%s' "$BODY" | grep -q "1000" \
  && pass "the web UI explains it too — no SSH needed to diagnose" || fail "the web UI did not explain the problem"
STATUS="$(curl -s "http://localhost:$((PORT + 1))/health" | json 'print(json.load(sys.stdin)["status"])')"
[ "$STATUS" = "degraded" ] && pass "/health reports degraded" || fail "/health said '${STATUS}'"
HEALTH="$(docker inspect --format '{{.State.Health.Status}}' "${NAME}-perm" 2>/dev/null || echo unknown)"
[ "$HEALTH" != "unhealthy" ] \
  && pass "the container stays healthy to Docker, so the explanation stays reachable" \
  || fail "the container was marked unhealthy and may be restarted or hidden"
docker rm -f "${NAME}-perm" >/dev/null 2>&1

# -------------------------------------------------------------------------- 10
# A real reported failure. Fastify rejects a route parameter over 100 characters
# with an HTTP 414 before any handler runs, and an episode's filename is a route
# parameter — so an episode with a long enough title simply never downloaded, and
# nothing appeared in SelfPod's own logs, because no SelfPod code was reached.
# This gets its own show so the checks above keep their one-episode assumptions.
step "10. An episode whose filename exceeds 100 characters still downloads"
mkdir -p "${WORK}/data/shows/long-names"
LONG="2026-08-03-Bulletin météo : forte dépression sur Ceuta, retour à la normale annoncé depuis Madrid.m4a"
cp "${FIXTURES}/sample.m4a" "${WORK}/data/shows/long-names/${LONG}"
wait_for_scan
LONG_TOKEN="$(api "${BASE}/api/shows" | json '
d = json.load(sys.stdin)
print(next((s["feedToken"] for s in d["shows"] if s["slug"] == "long-names"), ""))
')"
LONG_URL="$(curl -s "${BASE}/feeds/long-names/${LONG_TOKEN}.xml" | python3 -c '
import re, sys
m = re.search(r"<enclosure url=\"([^\"]+)\"", sys.stdin.read())
print(m.group(1).replace("&amp;", "&") if m else "")
')"
LONG_CODE="$(curl -s -o "${WORK}/long.m4a" -w '%{http_code}' -A 'Pocket Casts/7.5 (iPhone; iOS 18.2)' "$LONG_URL")"
if [ "$LONG_CODE" = "200" ] && cmp -s "${WORK}/long.m4a" "${FIXTURES}/sample.m4a"; then
  pass "a 100+ character filename downloads byte-identically (no HTTP 414)"
else
  fail "the long filename returned HTTP ${LONG_CODE}"
fi

# -------------------------------------------------------------------------- 11
step "11. Downloads, streams and failures are counted, without storing the token"
curl -s -o /dev/null -H 'Range: bytes=0-999' -A 'Overcast/2024' "$LONG_URL"
sleep 2
STATS="$(api "${BASE}/api/stats")"
printf '%s' "$STATS" | json '
d = json.load(sys.stdin)["overview"]
sys.exit(0 if d["downloads"] >= 1 and d["streams"] >= 1 else 1)
' && pass "a whole-file fetch counted as a download, a range fetch as a stream" \
  || fail "downloads and streams were not counted separately: ${STATS}"

# The file is removed underneath a request, which is what a subscriber's failed
# download looks like from the server's side.
rm -f "${WORK}/data/shows/long-names/${LONG}"
curl -s -o /dev/null -A 'Pocket Casts/7.5 (iPhone)' "$LONG_URL"
sleep 2
FAILURES="$(api "${BASE}/api/stats" | json 'print(json.load(sys.stdin)["overview"]["failures"])')"
[ "${FAILURES:-0}" -ge 1 ] \
  && pass "a request that could not be served is recorded as a failure" \
  || fail "the failed request was not recorded"
# Deliberately not matching one exact sentence: the file can vanish before the
# size check or between it and the read, and those are different messages. What
# must always hold is that no failure is left without an explanation.
api "${BASE}/api/stats/log?failuresOnly=1" | json '
d = json.load(sys.stdin)["entries"]
bad = [r for r in d if not (r.get("error") or "").strip()]
if bad:
    print("rows with no reason:", [(r["status_code"], r["kind"]) for r in bad])
sys.exit(1 if bad or not d else 0)
' && pass "every failure carries a plain-language reason" \
  || fail "a failure was recorded with no readable explanation"
api "${BASE}/api/stats/log" | grep -q "$LONG_TOKEN" \
  && fail "the feed token leaked into the access log" \
  || pass "the feed token is never stored in the access log"

step "12. A podcast app that already has the feed is answered 304, and still counted"

# This one is here rather than only in the unit suite for a specific reason: the
# recording hangs off socket lifecycle events, and fastify.inject fires them a
# different number of times than a real socket does. A conditional poll returning
# 304 without being recorded is invisible in-process and obvious here.
POLL_SLUG="$(api "${BASE}/api/shows" | json '
d = json.load(sys.stdin)["shows"]
print(d[0]["slug"] if d else "")')"
POLL_TOKEN="$(api "${BASE}/api/shows" | json '
d = json.load(sys.stdin)["shows"]
print(d[0]["feedToken"] if d else "")')"
POLL_URL="${BASE}/feeds/${POLL_SLUG}/${POLL_TOKEN}.xml"

POLL_ETAG="$(curl -s -D- -o /dev/null "$POLL_URL" | awk 'tolower($1)=="etag:"{print $2}' | tr -d '\r')"
[ -n "$POLL_ETAG" ] \
  && pass "the feed carries an ETag to revalidate against" \
  || fail "no ETag on the feed, so nothing can be revalidated"

curl -s -D- -o /dev/null -H "If-None-Match: ${POLL_ETAG}" "$POLL_URL" \
  | grep -qE '^HTTP/[0-9.]+ 304' \
  && pass "an unchanged feed answers 304 rather than resending itself" \
  || fail "a conditional request re-sent the whole feed"

# The Cloudflare case: a proxy may re-label a strong validator as weak. Comparing
# the two as exact strings — which is what SelfPod used to do — silently turns
# every poll back into a full download, with no error anywhere to notice.
curl -s -D- -o /dev/null -H "If-None-Match: W/${POLL_ETAG}" "$POLL_URL" \
  | grep -qE '^HTTP/[0-9.]+ 304' \
  && pass "a validator relabelled in transit still revalidates" \
  || fail "a weak validator was not matched, so every poll downloads the feed again"

# Per-show figures are spread onto the show itself, not nested under a "stats"
# key. No default and no error swallowing here on purpose: a wrong path that
# quietly reads zero would make this check pass against a broken app for ever.
feed_checks() {
  api "${BASE}/api/stats" | json '
d = json.load(sys.stdin)["shows"]
print(sum(s["feedFetches"] for s in d))'
}
BEFORE_CHECKS="$(feed_checks)"
curl -s -o /dev/null -A 'Pocket Casts/7.5 (iPhone)' -H "If-None-Match: ${POLL_ETAG}" "$POLL_URL"
sleep 2
AFTER_CHECKS="$(feed_checks)"
[ "${AFTER_CHECKS:-0}" -gt "${BEFORE_CHECKS:-0}" ] \
  && pass "the 304 is counted as a feed check, so a well-behaved app is not invisible" \
  || fail "a conditional poll was not recorded (${BEFORE_CHECKS} -> ${AFTER_CHECKS})"

# A 304 completed and deliberately carried no body. That is a zero, not the null
# that means "the transfer died and we cannot know".
api "${BASE}/api/stats/log" | json '
rows = [r for r in json.load(sys.stdin)["entries"] if r["kind"] == "feed" and r["status_code"] == 304]
bad = [r for r in rows if r["bytes_sent"] is None]
if not rows:
    print("no 304 rows recorded at all")
sys.exit(1 if bad or not rows else 0)
' && pass "a 304 records zero bytes, not an unknown" \
  || fail "a 304 was recorded with no byte figure"

# Compression is scoped to the feed on purpose: audio is already compressed and is
# served with byte ranges, where a content-coding would spend CPU to break seeking.
curl -s -D- -o /dev/null --compressed "$POLL_URL" \
  | grep -qi '^content-encoding: *gzip' \
  && pass "the feed is compressed when the app asks for it" \
  || fail "the feed was sent uncompressed to a client that accepts gzip"

step "13. An episode dated in the future stays out of the feed until its time"

# The publish-date picker has always accepted a date in the future, and used to
# publish immediately anyway — the app doing something reasonable and never saying
# it had.
FUTURE_EP="$(api "${BASE}/api/shows/$(api "${BASE}/api/shows" | json '
print(json.load(sys.stdin)["shows"][0]["id"])')" | json '
d = json.load(sys.stdin)["show"]["episodes"]
print(d[0]["id"] if d else "")')"

BEFORE_ITEMS="$(curl -s "$POLL_URL" | grep -c '<item>')"
FUTURE_DATE="$(python3 -c "
import datetime
print((datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=2)).strftime('%Y-%m-%dT%H:%M'))")"
api -X PATCH -H 'Content-Type: application/json' \
  -d "{\"pubDate\":\"${FUTURE_DATE}\"}" "${BASE}/api/episodes/${FUTURE_EP}" >/dev/null
AFTER_ITEMS="$(curl -s "$POLL_URL" | grep -c '<item>')"
[ "${AFTER_ITEMS}" -lt "${BEFORE_ITEMS}" ] \
  && pass "a future publish date holds the episode out of the feed" \
  || fail "a future-dated episode was published anyway (${BEFORE_ITEMS} -> ${AFTER_ITEMS})"

curl -s "$POLL_URL" | grep -q "$FUTURE_EP" \
  && fail "the scheduled episode is still in the feed" \
  || pass "no podcast app can see it yet"

# Setting the date back publishes it again, with no scan and nothing restarted.
PAST_DATE="$(python3 -c "
import datetime
print((datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=5)).strftime('%Y-%m-%dT%H:%M'))")"
api -X PATCH -H 'Content-Type: application/json' \
  -d "{\"pubDate\":\"${PAST_DATE}\"}" "${BASE}/api/episodes/${FUTURE_EP}" >/dev/null
BACK_ITEMS="$(curl -s "$POLL_URL" | grep -c '<item>')"
[ "${BACK_ITEMS}" -eq "${BEFORE_ITEMS}" ] \
  && pass "it rejoins the feed once its time has passed" \
  || fail "the episode did not come back (${BACK_ITEMS} vs ${BEFORE_ITEMS})"

step "14. A followed feed downloads only the episodes that match, and republishes them"

# In acceptance rather than only in-process because three things here are properties
# of the container and not of the code: outbound DNS from inside the network
# namespace, the PUID's ability to write into the show folder, and the fact that
# ALLOW_PRIVATE_FEED_HOSTS has to be set at all — which is itself the point. Without
# that variable SelfPod refuses to fetch from a private address, and the fixture feed
# below is on one.

FEED_DIR="${WORK}/remote"
mkdir -p "$FEED_DIR"
cp "${FIXTURES}/sample.mp3" "${FEED_DIR}/a.mp3"
# Distinct bytes per episode: SelfPod identifies episodes by content, so three copies
# of one file are correctly refused as duplicates and would prove nothing.
printf 'bbbbbbbbbbbbbbbb' >> "${FEED_DIR}/a.mp3"
cp "${FIXTURES}/sample.mp3" "${FEED_DIR}/b.mp3"
printf 'cccccccccccccccccccccccccccccccc' >> "${FEED_DIR}/b.mp3"
cp "${FIXTURES}/sample.mp3" "${FEED_DIR}/c.mp3"
printf 'dddddddddddddddddddddddddddddddddddddddddddddddd' >> "${FEED_DIR}/c.mp3"

REMOTE_NET="${NAME}-net"
REMOTE_NAME="${NAME}-feed"
docker network create "$REMOTE_NET" >/dev/null 2>&1 || true
docker network connect "$REMOTE_NET" "$NAME" >/dev/null 2>&1 || true

cat > "${FEED_DIR}/feed.xml" <<XML
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel>
<title>Remote Tape Club</title><language>en-gb</language>
<item><title>An interview with the archivist</title><guid>rem-a</guid>
<pubDate>Tue, 04 Mar 2025 09:00:00 GMT</pubDate><itunes:duration>2700</itunes:duration>
<enclosure url="http://${REMOTE_NAME}/a.mp3" type="audio/mpeg" length="5000"/></item>
<item><title>Bonus: outtakes</title><guid>rem-b</guid>
<pubDate>Mon, 03 Mar 2025 09:00:00 GMT</pubDate><itunes:duration>2700</itunes:duration>
<enclosure url="http://${REMOTE_NAME}/b.mp3" type="audio/mpeg" length="5000"/></item>
<item><title>An interview about tape</title><guid>rem-c</guid>
<pubDate>Sun, 02 Mar 2025 09:00:00 GMT</pubDate><itunes:duration>2700</itunes:duration>
<enclosure url="http://${REMOTE_NAME}/c.mp3" type="audio/mpeg" length="5000"/></item>
</channel></rss>
XML

docker run -d --name "$REMOTE_NAME" --network "$REMOTE_NET" \
  -v "${FEED_DIR}:/usr/share/nginx/html:ro" nginx:alpine >/dev/null 2>&1
sleep 3

# The container has to be told, explicitly, that this one private address is allowed.
# Everything else about the guard stays in force — scheme, port, credentials,
# redirects, and every other address.
docker rm -f "$NAME" >/dev/null 2>&1
docker run -d --name "$NAME" -p "${PORT}:8080" --network "$REMOTE_NET" \
  -v "${WORK}/data:/data" \
  -e PUBLIC_BASE_URL="$BASE" \
  -e ADMIN_PASSWORD=acceptance-password \
  -e RESCAN_INTERVAL_SECONDS=60 \
  -e SUBSCRIPTIONS_ENABLED=1 \
  -e ALLOW_PRIVATE_FEED_HOSTS="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$REMOTE_NAME" 2>/dev/null)" \
  -e TZ=Europe/London \
  "$IMAGE" >/dev/null
wait_for_health || { fail "container did not come back up for the subscription tests"; }
rm -f "$JAR"
curl -s -c "$JAR" -X POST "${BASE}/api/login" \
  -H 'Content-Type: application/json' -H 'Sec-Fetch-Site: same-origin' \
  -d '{"username":"admin","password":"acceptance-password"}' >/dev/null

# Turned on over the API, not by the environment variable above.
#
# SUBSCRIPTIONS_ENABLED is a *seed*: it populates the setting on first run and after
# that the database wins, like every other setting in SelfPod. This data directory
# already exists from the earlier steps, so the seed does nothing here — which is
# exactly the situation an operator upgrading an existing install is in, and worth
# exercising rather than papering over with a fresh volume.
api -X PATCH -H 'Content-Type: application/json' \
  -d '{"subscriptionsEnabled":true}' "${BASE}/api/settings" >/dev/null

SUB_SHOW="$(api "${BASE}/api/shows" | json '
print(json.load(sys.stdin)["shows"][0]["id"])')"

SUB_ID="$(api -X POST -H 'Content-Type: application/json' \
  -d "{\"feedUrl\":\"http://${REMOTE_NAME}/feed.xml\",\"includeKeywords\":\"interview\",\"excludeKeywords\":\"bonus\",\"backfillCount\":10}" \
  "${BASE}/api/shows/${SUB_SHOW}/subscriptions" | json '
d = json.load(sys.stdin).get("subscription")
print(d["id"] if d else "")')"
[ -n "$SUB_ID" ] \
  && pass "a feed on an allowed address can be followed" \
  || fail "the subscription could not be created"

api -X POST "${BASE}/api/subscriptions/${SUB_ID}/poll" >/dev/null
sleep 6

DOWNLOADED="$(api "${BASE}/api/subscriptions/${SUB_ID}/items" | json '
rows = json.load(sys.stdin)["items"]
print(sum(1 for r in rows if r["decision"] == "downloaded"))')"
[ "${DOWNLOADED:-0}" -eq 2 ] \
  && pass "exactly the two matching episodes were downloaded" \
  || fail "expected 2 downloads, got ${DOWNLOADED}"

# The whole point of the feature: they are ordinary episodes now, in the feed the
# user's podcast app actually reads.
SUB_SLUG="$(api "${BASE}/api/shows" | json '
print(json.load(sys.stdin)["shows"][0]["slug"])')"
SUB_TOKEN="$(api "${BASE}/api/shows" | json '
print(json.load(sys.stdin)["shows"][0]["feedToken"])')"
SUB_FEED="$(curl -s "${BASE}/feeds/${SUB_SLUG}/${SUB_TOKEN}.xml")"

echo "$SUB_FEED" | grep -q "An interview with the archivist" \
  && pass "a downloaded episode is republished under the publisher's own title" \
  || fail "the downloaded episode never reached the feed"

echo "$SUB_FEED" | grep -q "Bonus: outtakes" \
  && fail "an excluded episode reached the feed" \
  || pass "the excluded episode is nowhere in the feed"

step "15. A refused episode is never fetched, and the reason is visible"

# Asserted against the fixture server's own access log, because "we did not download
# it" is not the same claim as "we never asked for it" — and only the second one is
# worth anything for bandwidth or for a publisher's download figures.
docker logs "$REMOTE_NAME" 2>&1 | grep -q "GET /b.mp3" \
  && fail "the excluded episode's audio was fetched anyway" \
  || pass "the excluded episode's audio was never requested"

docker logs "$REMOTE_NAME" 2>&1 | grep -q "GET /a.mp3" \
  && pass "…while the matching one was, so the check above means something" \
  || fail "no audio was fetched at all, so the previous check proves nothing"

api "${BASE}/api/subscriptions/${SUB_ID}/items?decision=rejected_declared" | json '
rows = json.load(sys.stdin)["items"]
bad = [r for r in rows if not r.get("detail")]
if not rows:
    print("no refusals were recorded")
sys.exit(1 if bad or not rows else 0)
' && pass "every refusal carries a sentence saying why" \
  || fail "a refusal was recorded with no explanation"

step "16. An unchanged feed costs one conditional request and no work"

BEFORE_ITEMS_SUB="$(api "${BASE}/api/subscriptions/${SUB_ID}/items" | json '
print(len(json.load(sys.stdin)["items"]))')"
sleep 61
api -X POST "${BASE}/api/subscriptions/${SUB_ID}/poll" >/dev/null
sleep 3

SUB_STATUS="$(api "${BASE}/api/subscriptions/${SUB_ID}" | json '
print(json.load(sys.stdin)["subscription"]["lastStatus"])')"
[ "$SUB_STATUS" = "not_modified" ] \
  && pass "the second check was answered 304 and did nothing" \
  || fail "an unchanged feed was re-processed (status: ${SUB_STATUS})"

AFTER_ITEMS_SUB="$(api "${BASE}/api/subscriptions/${SUB_ID}/items" | json '
print(len(json.load(sys.stdin)["items"]))')"
[ "$AFTER_ITEMS_SUB" = "$BEFORE_ITEMS_SUB" ] \
  && pass "and recorded nothing new" \
  || fail "a 304 still changed the ledger (${BEFORE_ITEMS_SUB} -> ${AFTER_ITEMS_SUB})"

step "17. SelfPod will not fetch a feed on an address it was not told to allow"

BLOCKED="$(api -X POST -H 'Content-Type: application/json' \
  -d '{"feedUrl":"http://192.168.99.99/feed.xml"}' \
  "${BASE}/api/subscriptions/preview" | json '
d = json.load(sys.stdin)
print(d.get("error", {}).get("message", "")[:60])')"
case "$BLOCKED" in
  *"private or local network"*)
    pass "a private address is refused even from inside the container" ;;
  *)
    fail "a private address was not refused (${BLOCKED})" ;;
esac

step "18. A show set to review holds its episodes, and says how many"

# The audio is generated rather than committed, for the same reason the unit tests
# generate theirs: a stitched file *is* "these frames, then those frames", and three
# episodes sharing one segment is the whole scenario. A checked-in blob would hide it.
mkdir -p "${WORK}/data/shows/ad-club"
python3 - "${WORK}/data/shows/ad-club" <<'PY'
import sys, pathlib

FRAME_BYTES = 417                      # MPEG-1 Layer III, 128 kbit/s, 44.1 kHz
FRAME_MS = 1152 / 44100 * 1000         # 26.12 ms

def frame(seed):
    header = bytes([0xFF, 0xFB, (9 << 4) | (0 << 2), (1 << 6)])
    payload = bytearray(FRAME_BYTES - 4)
    x = (seed * 2654435761) & 0xFFFFFFFF
    for i in range(len(payload)):
        x = (x ^ (x << 13)) & 0xFFFFFFFF
        x ^= x >> 17
        x = (x ^ (x << 5)) & 0xFFFFFFFF
        payload[i] = x & 0xFE          # never 0xFF, so no payload byte looks like a sync
    return header + bytes(payload)

def seconds(n):
    return round(n * 1000 / FRAME_MS)

def segment(start, count):
    return b"".join(frame(start + i) for i in range(count))

out = pathlib.Path(sys.argv[1])
for n in range(3):
    # Programme, the same 30-second sponsor read every episode carries, more programme.
    (out / f"episode-{n + 1}.mp3").write_bytes(
        segment(100_000 + n * 50_000, seconds(40))
        + segment(2_000, seconds(30))
        + segment(600_000 + n * 50_000, seconds(40))
    )
PY

wait_for_scan 12
AD_SHOW_ID="$(api "${BASE}/api/shows" | json '
print(next(s["id"] for s in json.load(sys.stdin)["shows"] if s["slug"] == "ad-club"))')"

api -X PATCH -H 'Content-Type: application/json' -d '{"mode":"review"}' \
  "${BASE}/api/shows/${AD_SHOW_ID}/ad-trim" >/dev/null
api -X POST "${BASE}/api/shows/${AD_SHOW_ID}/ad-detect" >/dev/null

AD_STATE="$(api "${BASE}/api/shows/${AD_SHOW_ID}/ad-segments")"
printf '%s' "$AD_STATE" | json '
d = json.load(sys.stdin)
sys.exit(0 if d["held"] == 3 and d["awaiting"] >= 1 else 1)' \
  && pass "three episodes are held, with something to decide about" \
  || fail "the show did not hold its episodes ($(printf '%s' "$AD_STATE" | head -c 120))"

AD_FEED_TOKEN="$(api "${BASE}/api/shows/${AD_SHOW_ID}" | json '
print(json.load(sys.stdin)["show"]["feedToken"])')"
HELD_FEED="$(curl -s "${BASE}/feeds/ad-club/${AD_FEED_TOKEN}.xml")"
# The positive control first: an error page has no <item> either, and would make the
# check below pass without SelfPod having held anything back.
printf '%s' "$HELD_FEED" | grep -q "<title>Ad Club</title>" \
  && pass "the feed builds and is this show's" \
  || fail "that is not the ad-club feed ($(printf '%s' "$HELD_FEED" | head -c 80))"
printf '%s' "$HELD_FEED" | grep -q "<item>" \
  && fail "a held episode was published anyway" \
  || pass "and none of its episodes is in it yet"

step "19. Approving a segment cuts the audio and shortens the feed"

SEG_ID="$(printf '%s' "$AD_STATE" | json '
d = json.load(sys.stdin)
print(next(s["id"] for s in d["segments"] if s["status"] == "candidate"))')"

# Everything the feed said before the cut, so the comparison is against real bytes
# rather than against an expectation written down here.
BEFORE_FEED="$(curl -s "${BASE}/feeds/ad-club/${AD_FEED_TOKEN}.xml")"
api -X POST -H 'Content-Type: application/json' -d '{"status":"approved"}' \
  "${BASE}/api/ad-segments/${SEG_ID}/decide" >/dev/null

AFTER_FEED="$(curl -s "${BASE}/feeds/ad-club/${AD_FEED_TOKEN}.xml")"
[ "$(printf '%s' "$AFTER_FEED" | grep -c '<item>')" = "3" ] \
  && pass "all three episodes are published now the decision is settled" \
  || fail "approving the segment did not release the episodes"

# The feed genuinely changed. Without this the checks below could pass on a feed that
# was already showing the untrimmed episodes for some unrelated reason.
[ "$BEFORE_FEED" != "$AFTER_FEED" ] \
  && pass "…and the feed is not what it was a moment ago" \
  || fail "the feed did not change at all"

printf '%s' "$AFTER_FEED" | grep -q 'url="[^"]*?v=[0-9a-f]\{12\}"' \
  && pass "each enclosure URL carries a content version" \
  || fail "the enclosure URL has no version, so replacing the bytes could corrupt a resumed download"

# 110 seconds of audio less a 30-second sponsor read.
printf '%s' "$AFTER_FEED" | json '
# Split rather than match: this string travels through a shell double-quoted context
# on its way to python, so a regex escape here is one backslash away from silently
# matching nothing — which is exactly what it did the first time.
body = sys.stdin.read()
stated = [chunk.split("<")[0] for chunk in body.split("<itunes:duration>")[1:]]
secs = [int(h) * 3600 + int(m) * 60 + int(s) for h, m, s in (v.split(":") for v in stated)]
if len(secs) != 3:
    print(f"expected three durations, found {len(secs)}: {stated}")
    sys.exit(1)
wrong = [v for v in secs if abs(v - 80) > 2]
if wrong:
    print(f"published {wrong} seconds; 110 less a 30-second read is 80")
sys.exit(1 if wrong else 0)' \
  && pass "…and states 1:20 — the 30 seconds are gone from every episode" \
  || fail "the published duration is not the trimmed one"

step "20. What is served is the original audio, minus the cut"

AD_EP_ID="$(api "${BASE}/api/shows/${AD_SHOW_ID}/episodes" | json '
print(json.load(sys.stdin)["episodes"][0]["id"])')"
AD_EP_FILE="$(api "${BASE}/api/shows/${AD_SHOW_ID}/episodes" | json '
print(json.load(sys.stdin)["episodes"][0]["filename"])')"
# The version the feed is currently advertising. The media route refuses any other,
# which is the whole point of putting it there: a client resuming a download after the
# audio changed must be told no, not handed a splice of two files.
AD_VERSION="$(printf '%s' "$AFTER_FEED" | json '
import re
body = sys.stdin.read()
print(re.findall(r"[?]v=([0-9a-f]{12})", body)[0])')"
MEDIA="${BASE}/media/ad-club/${AD_FEED_TOKEN}/${AD_EP_ID}/${AD_EP_FILE}?v=${AD_VERSION}"

curl -s -o "${WORK}/trimmed.mp3" "$MEDIA"
curl -s -o "${WORK}/tail.mp3" -H 'Range: bytes=200000-' "$MEDIA"

# And a version that is not the published one is refused rather than served the
# current bytes — the check that makes the version mean anything at all.
STALE="$(curl -s -o /dev/null -w '%{http_code}' \
  "${BASE}/media/ad-club/${AD_FEED_TOKEN}/${AD_EP_ID}/${AD_EP_FILE}?v=000000000000")"
[ "$STALE" = "404" ] \
  && pass "a superseded version is refused, not quietly served the new audio" \
  || fail "a stale version was served (${STALE})"

python3 - "${WORK}/trimmed.mp3" "${WORK}/tail.mp3" "${WORK}/data/shows/ad-club/${AD_EP_FILE}" <<'PY'
import sys, pathlib
served, tail, original = (pathlib.Path(p).read_bytes() for p in sys.argv[1:4])
problems = []
# The claim is not "similar" — it is the same bytes, because nothing was decoded.
if served[:150_000] != original[:150_000]:
    problems.append("the audio before the cut is not byte-identical to the original")
if len(served) >= len(original):
    problems.append("nothing was actually removed")
# The failure this guards: a client holding the first half of one file and asking for
# the rest gets the second half of a different one, and stitches them silently.
if tail != served[200_000:]:
    problems.append("a ranged read returned different audio from a whole read")
for p in problems:
    print(p)
sys.exit(1 if problems else 0)
PY
if [ $? -eq 0 ]; then
  pass "byte-identical outside the cut, and range reads agree with whole reads"
else
  fail "the trimmed audio served does not match the original outside the cut"
fi

# The originals are the owner's. Whatever the trimming did, it did not do it to them.
[ "$(python3 -c "
import pathlib, sys
d = pathlib.Path('${WORK}/data/shows/ad-club')
print(len(sorted(p.name for p in d.iterdir() if p.suffix == '.mp3')))")" = "3" ] \
  && pass "the three files on the share are untouched and still the only ones there" \
  || fail "trimming changed what is in the show folder"

step "21. Changing your mind puts the audio back"

api -X POST -H 'Content-Type: application/json' -d '{"status":"rejected"}' \
  "${BASE}/api/ad-segments/${SEG_ID}/decide" >/dev/null
# No version now: the episode is untrimmed again, and the absence of one is itself the
# claim that says so.
curl -s -o "${WORK}/restored.mp3" \
  "${BASE}/media/ad-club/${AD_FEED_TOKEN}/${AD_EP_ID}/${AD_EP_FILE}"

[ "$(wc -c < "${WORK}/restored.mp3")" = "$(wc -c < "${WORK}/data/shows/ad-club/${AD_EP_FILE}")" ] \
  && pass "the episode is served whole again" \
  || fail "rejecting the segment did not restore the audio"

step "22. Repeated audio is found even when it was re-encoded, not copied"

# The case the whole detector exists for, and the one a synthetic fixture cannot show.
# Each episode carries the same six-second theme, but a *differently encoded* copy of
# it — 48 kbit/s in two of them and 80 in the third — around programme of its own. The
# three copies of the theme share almost no bytes, so nothing that compares bytes finds
# anything here at all.
mkdir -p "${WORK}/data/shows/re-encoded"
# Programme of its own in each episode, so the theme is genuinely the only thing they
# share — and the third episode's copy of the theme is encoded at a different bitrate.
cat "${FIXTURES}/prog-a.mp3" "${FIXTURES}/theme-48k.mp3" "${FIXTURES}/prog-b.mp3" \
  > "${WORK}/data/shows/re-encoded/part-1.mp3"
cat "${FIXTURES}/prog-b.mp3" "${FIXTURES}/theme-48k.mp3" "${FIXTURES}/prog-c.mp3" \
  > "${WORK}/data/shows/re-encoded/part-2.mp3"
cat "${FIXTURES}/prog-c.mp3" "${FIXTURES}/theme-80k.mp3" "${FIXTURES}/prog-a.mp3" \
  > "${WORK}/data/shows/re-encoded/part-3.mp3"

wait_for_scan 12
RE_SHOW_ID="$(api "${BASE}/api/shows" | json '
print(next(s["id"] for s in json.load(sys.stdin)["shows"] if s["slug"] == "re-encoded"))')"
api -X PATCH -H 'Content-Type: application/json' -d '{"mode":"review","minEpisodes":2}' \
  "${BASE}/api/shows/${RE_SHOW_ID}/ad-trim" >/dev/null
api -X POST "${BASE}/api/shows/${RE_SHOW_ID}/ad-detect" >/dev/null

api "${BASE}/api/shows/${RE_SHOW_ID}/ad-segments" | json '
# No escaped quotes anywhere: this string travels through a shell double-quoted
# context on its way to python, and a backslash here is how the last two checks in
# this file silently stopped testing anything.
d = json.load(sys.stdin)
segs = d["segments"]
found = [s for s in segs if s["durationSeconds"] >= 4]
if not found:
    print("nothing found; " + str(len(segs)) + " segments, held=" + str(d["held"]))
    sys.exit(1)
best = max(found, key=lambda s: s["episodeCount"])
if best["episodeCount"] < 3:
    print("the theme was found in only " + str(best["episodeCount"]) + " episodes")
    sys.exit(1)
if not (4.5 <= best["durationSeconds"] <= 8.0):
    print("a six-second theme was measured as " + str(best["durationSeconds"]) + "s")
    sys.exit(1)
' && pass "a re-encoded theme is found in all three episodes, at about the right length" \
  || fail "re-encoded repeated audio was not found"

step "23. A sponsor read in the words is found across episodes that sound nothing alike"

# The case the recogniser exists for: the same script read by two different voices.
# The acoustic fingerprint cannot match them — they share no sound — and the words
# can. Each episode is its own programme with the read spoken at the start; the two
# reads were made with macOS `say -v Daniel` and `say -v Samantha` from one text, so
# nothing but the words is common to them. This also proves the whisper binary the
# image chose for this CPU actually runs on real speech, not only on the smoke file.
mkdir -p "${WORK}/data/shows/spoken"
cat "${FIXTURES}/sponsor-en-daniel.mp3" "${FIXTURES}/prog-a.mp3" "${FIXTURES}/prog-b.mp3" \
  > "${WORK}/data/shows/spoken/monday.mp3"
cat "${FIXTURES}/sponsor-en-samantha.mp3" "${FIXTURES}/prog-c.mp3" "${FIXTURES}/prog-a.mp3" \
  > "${WORK}/data/shows/spoken/tuesday.mp3"

wait_for_scan 12
SP_SHOW_ID="$(api "${BASE}/api/shows" | json '
print(next(s["id"] for s in json.load(sys.stdin)["shows"] if s["slug"] == "spoken"))')"
api -X PATCH -H 'Content-Type: application/json' -d '{"mode":"review","minEpisodes":2}' \
  "${BASE}/api/shows/${SP_SHOW_ID}/ad-trim" >/dev/null
api -X POST "${BASE}/api/shows/${SP_SHOW_ID}/ad-detect" >/dev/null

api "${BASE}/api/shows/${SP_SHOW_ID}/ad-segments" | json '
d = json.load(sys.stdin)
if d.get("listening", {}).get("engine") != "ready":
    print("the recogniser is not ready in the container: " + str(d.get("listening")))
    sys.exit(1)
spoken = [s for s in d["segments"] if s["source"] == "transcript"]
if not spoken:
    print("nothing heard; " + str(len(d["segments"])) + " segments, listening=" + str(d.get("listening")))
    sys.exit(1)
best = max(spoken, key=lambda s: s["episodeCount"])
if best["episodeCount"] < 2:
    print("the read was heard in only " + str(best["episodeCount"]) + " episode")
    sys.exit(1)
if not (5.0 <= best["durationSeconds"] <= 12.0):
    print("an eight-second read was measured as " + str(best["durationSeconds"]) + "s")
    sys.exit(1)
ids = [c["id"] for c in best["cues"]]
if not any(i in ids for i in ("brought_to_you_by", "use_code", "promo_code", "web_address", "percent_off", "terms_apply")):
    print("no sponsor cue on the read: " + str(ids) + " / " + str(best.get("rawText")))
    sys.exit(1)
if not best.get("why", {}).get("sentence"):
    print("no sentence saying what will happen")
    sys.exit(1)
if not best.get("excerpt", {}).get("words"):
    print("no words on the card")
    sys.exit(1)
' && pass "the same read, in two voices, is heard in both episodes with its cues and its words" \
  || fail "a spoken sponsor read was not found across episodes"

# The health endpoint must not be carrying a recogniser complaint either: a broken
# binary that found nothing would otherwise pass this step by accident.
api "${BASE}/api/status" | json '
d = json.load(sys.stdin)
issues = [i["key"] for i in d.get("issues", []) if i["key"].startswith("whisper")]
if issues:
    print("health complains about the recogniser: " + str(issues))
    sys.exit(1)
' && pass "no health warning about the recogniser" \
  || fail "the recogniser is reported unhealthy"

# ---------------------------------------------------------------------- report
step "Result"
printf '  %d passed, %d failed\n\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
