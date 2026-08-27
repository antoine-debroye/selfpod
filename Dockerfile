# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Build stage — installs dependencies, including any native module that has to
# be compiled. The toolchain lives only here so it never ships in the runtime
# image. better-sqlite3 and sharp both publish musl prebuilds for amd64 and
# arm64, so this normally installs without compiling anything; python3/make/g++
# are kept as insurance against a missing prebuild.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json ./

# `--omit=dev` is safe; omitting *optional* dependencies is not — sharp's
# platform binaries are optional deps, and dropping them breaks it at runtime.
RUN npm ci --omit=dev

# Fail the build here rather than at container start if a native module is unusable.
RUN node -e "require('better-sqlite3'); require('sharp'); console.log('native modules OK')"

COPY src ./src

# ---------------------------------------------------------------------------
# Runtime stage
# ---------------------------------------------------------------------------
FROM node:22-alpine

# su-exec drops privileges without leaving a process between PID 1 and node;
# shadow provides usermod/groupmod for the PUID/PGID pattern; tzdata makes the
# TZ environment variable work for everything, not just Node's bundled ICU.
RUN apk add --no-cache su-exec shadow tzdata

# The node:*-alpine images ship a `node` user at UID/GID 1000 — exactly the
# default PUID/PGID. Left in place, `usermod -u 1000` would fail on a default
# configuration, so the user is removed and replaced with SelfPod's own.
RUN deluser --remove-home node \
 && addgroup -g 1000 selfpod \
 && adduser -u 1000 -G selfpod -h /app -s /sbin/nologin -D selfpod

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY src ./src
COPY docker ./docker
# Ships the admin-password reset, which is the only way back into an instance whose
# generated password has scrolled out of the container log.
COPY scripts ./scripts

RUN chmod +x docker/entrypoint.sh \
 && mkdir -p /data \
 && chown selfpod:selfpod /app

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    PUID=1000 \
    PGID=1000

EXPOSE 8080
VOLUME ["/data"]

# Reports healthy whenever the process answers, including in a degraded state:
# an unhealthy container gets restarted or hidden by the host UI, which would
# take away the very page explaining what is wrong.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "/app/docker/healthcheck.mjs"]

ENTRYPOINT ["/app/docker/entrypoint.sh"]

LABEL org.opencontainers.image.title="SelfPod" \
      org.opencontainers.image.description="Self-hosted podcast server for private feeds. Drop a file in a folder; it's an episode." \
      org.opencontainers.image.source="https://github.com/antoine-debroye/selfpod" \
      # MIT, but the image also contains an LGPL-2.1 MP3 decoder (mpg123, via
      # mpg123-decoder) so that SelfPod can compare what two episodes sound like.
      # THIRD-PARTY-LICENSES.md says what that obliges and how it is met.
      org.opencontainers.image.licenses="MIT AND LGPL-2.1-or-later"
