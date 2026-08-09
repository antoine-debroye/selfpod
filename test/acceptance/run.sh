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
wait_for_scan
ITEMS="$(feed | grep -c '<item>')"
[ "$ITEMS" = "1" ] && pass "a missing file does not immediately disappear from the feed" || fail "expected 1 item during grace, saw ${ITEMS}"

docker exec "$NAME" node -e '
const D = require("better-sqlite3");
const db = new D("/data/db.sqlite");
db.prepare("UPDATE settings SET value=? WHERE key=?").run("60", "missing_grace_seconds");
db.prepare("UPDATE episodes SET missing_since=? WHERE status=?")
  .run(new Date(Date.now() - 3600e3).toISOString(), "missing");
' >/dev/null 2>&1
printf '  … waiting for the scheduled sweep\n'
sleep 70
ITEMS="$(feed | grep -c '<item>')"
[ "$ITEMS" = "0" ] && pass "it dropped out of the feed once the grace period passed" || fail "expected 0 items after grace, saw ${ITEMS}"

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
sleep 8
docker logs "${NAME}-perm" 2>&1 | grep -qi 'CANNOT READ /locked as UID 1000' \
  && pass "the container log names the exact path and UID" || fail "the log did not explain the permission problem"
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

# ---------------------------------------------------------------------- report
step "Result"
printf '  %d passed, %d failed\n\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
