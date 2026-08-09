#!/bin/sh
# SelfPod container entrypoint (spec §13.1).
#
# Permission handling on a NAS is the single most common way a self-hosted app
# fails, so this script does three things and nothing else:
#
#   1. Aligns the app user with the PUID/PGID the operator chose, so the container
#      reads and writes files as whoever owns them on the host. SelfPod never
#      chmods or chowns the user's media — the alternative, an app that rewrites
#      permissions on your library, is how the original hand-rolled version broke
#      an SMB share's ACLs.
#   2. Tests that /data is actually readable and writable as that user, and says
#      so loudly if not — but still starts, because the web UI carries the same
#      message and must stay reachable without SSH.
#   3. Hands off to node with exec, so signals reach it directly and shutdown is
#      clean (which matters: shutdown checkpoints the database).

set -eu

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
DATA_DIR="${DATA_DIR:-/data}"
APP_USER="selfpod"

log() {
  printf '%s selfpod-entrypoint: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$1" >&2
}

# ---------------------------------------------------------------------------
# Running as a non-root user (someone set `user:` in compose, or the platform
# enforces it). PUID/PGID cannot be applied, and that is fine — but say so,
# instead of failing with a confusing usermod error.
# ---------------------------------------------------------------------------
if [ "$(id -u)" -ne 0 ]; then
  log "started as UID $(id -u), GID $(id -g); PUID/PGID are ignored because changing users needs root."
  log "if file permissions cause trouble, remove the container's \`user:\` setting and use PUID/PGID instead."
  exec node /app/src/index.js
fi

# ---------------------------------------------------------------------------
# Align the app user with the requested ids. -o allows a duplicate id, which is
# what makes PUID=0 or a collision with another account work rather than abort.
# ---------------------------------------------------------------------------
if [ "$PUID" = "0" ] || [ "$PGID" = "0" ]; then
  log "PUID/PGID is 0, so SelfPod will run as root. That works, but matching the owner of your files is safer."
  RUN_AS="0:0"
else
  CURRENT_UID="$(id -u "$APP_USER" 2>/dev/null || echo '')"
  CURRENT_GID="$(id -g "$APP_USER" 2>/dev/null || echo '')"

  if [ "$CURRENT_GID" != "$PGID" ]; then
    groupmod -o -g "$PGID" "$APP_USER" 2>/dev/null \
      || log "could not set group id to $PGID; continuing with $CURRENT_GID."
  fi
  if [ "$CURRENT_UID" != "$PUID" ]; then
    usermod -o -u "$PUID" "$APP_USER" 2>/dev/null \
      || log "could not set user id to $PUID; continuing with $CURRENT_UID."
  fi

  RUN_AS="$(id -u "$APP_USER"):$(id -g "$APP_USER")"
  log "running as $APP_USER ($RUN_AS)"
fi

# Only ever touches the app's own directory, never anything under /data.
chown -R "$RUN_AS" /app/node_modules 2>/dev/null || true

# ---------------------------------------------------------------------------
# Read + write self-test as the target user. A failure is reported in detail and
# passed to the app, which surfaces a persistent banner in the UI.
# ---------------------------------------------------------------------------
SELFTEST_RESULT="ok"

if [ ! -d "$DATA_DIR" ]; then
  mkdir -p "$DATA_DIR" 2>/dev/null || true
fi

if ! su-exec "$RUN_AS" sh -c "[ -r '$DATA_DIR' ] && [ -x '$DATA_DIR' ]" 2>/dev/null; then
  SELFTEST_RESULT="failed"
  log "----------------------------------------------------------------"
  log "CANNOT READ $DATA_DIR as UID ${PUID}, GID ${PGID}."
  log "Set PUID/PGID to the user that owns your files (run \`id <username>\`"
  log "on the host), or grant that user access to the dataset."
  log "SelfPod will still start so the web interface can explain this."
  log "----------------------------------------------------------------"
elif ! su-exec "$RUN_AS" sh -c "touch '$DATA_DIR/.selfpod-entrypoint-test' && rm -f '$DATA_DIR/.selfpod-entrypoint-test'" 2>/dev/null; then
  SELFTEST_RESULT="failed"
  log "----------------------------------------------------------------"
  log "CANNOT WRITE TO $DATA_DIR as UID ${PUID}, GID ${PGID}."
  log "SelfPod needs write access there for its database and uploads."
  log "Set PUID/PGID to the owner of that folder, or give that user write"
  log "access to it. SelfPod does not change permissions on your files."
  log "SelfPod will still start so the web interface can explain this."
  log "----------------------------------------------------------------"
else
  log "$DATA_DIR is readable and writable"
fi

export SELFPOD_DATA_SELFTEST="$SELFTEST_RESULT"

# exec, so node receives SIGTERM directly and can shut down cleanly.
exec su-exec "$RUN_AS" node /app/src/index.js
