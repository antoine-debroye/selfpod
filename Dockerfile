# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Build stage — installs dependencies, including any native module that has to
# be compiled. The toolchain lives only here so it never ships in the runtime
# image. better-sqlite3 and sharp both publish musl prebuilds for amd64 and
# arm64, so this normally installs without compiling anything; python3/make/g++
# are kept as insurance against a missing prebuild.
# ---------------------------------------------------------------------------
# Pinned by digest (the multi-arch index, so the same line serves amd64 and arm64) and
# not just by tag, so a rebuild gets the base image that was reviewed and not whatever
# the tag points at that day. To bump: `docker buildx imagetools inspect node:22-alpine
# --format '{{.Manifest.Digest}}'`, then paste the digest here and in the runtime stage.
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS build

# cmake and git are for whisper.cpp, below; the rest is insurance for native modules.
RUN apk add --no-cache python3 make g++ cmake git

WORKDIR /app

COPY package.json package-lock.json ./

# `--omit=dev` is safe; omitting *optional* dependencies is not — sharp's
# platform binaries are optional deps, and dropping them breaks it at runtime.
RUN npm ci --omit=dev

# Drops the 24 MB of better-sqlite3 that this platform never reads (the SQLite source
# and the seven other platforms' binaries) — before the check below, so the check also
# proves the module loads with only what is kept. The script says what it removed.
COPY docker/trim-node-modules.mjs ./docker/
RUN node docker/trim-node-modules.mjs node_modules

# Fail the build here rather than at container start if a native module is unusable.
RUN node -e "require('better-sqlite3'); require('sharp'); console.log('native modules OK')"

COPY src ./src

# ---------------------------------------------------------------------------
# whisper.cpp — the speech recogniser behind spoken-advert detection (spec §19.6).
#
# Built from a pinned commit rather than installed, because there is no musl build to
# install and because what goes into the image should be what was reviewed. MIT.
#
# Two builds on amd64, chosen at boot by src/lib/cpu-features.js: `-v3` uses AVX2
# and is several times faster; `-v2` stops at SSE4.2, because the Celerons in most
# small NAS boxes have no AVX at all and a binary that assumes it dies with an
# illegal instruction. One build on arm64. GGML_NATIVE is off in every case: the
# build host is not the box this runs on. OpenMP is off because musl has no libgomp
# and ggml's own thread pool is enough for two threads. Static, so nothing is looked
# up at run time.
#
# The model is fetched here, checked against a pinned digest, and never fetched
# again: the running container makes no request this feature adds.
# ---------------------------------------------------------------------------
# The commit tag b4938 pointed at when it was reviewed. A tag can be moved; a commit
# cannot. To bump: pick a release tag, then
# `gh api repos/ggml-org/whisper.cpp/git/ref/tags/<tag> --jq .object.sha` (if that
# object is itself a tag, `gh api repos/ggml-org/whisper.cpp/git/tags/<sha>` gives the
# commit) and paste it here and in Dockerfile.cuda.
ARG WHISPER_CPP_COMMIT=371b5a7561823ab2bb32142d2751e35e7534727b
# Two models. `base` is the default: 60 MB, quick, good enough for English. `small` is
# 190 MB and about three times the work, and markedly better in French — set
# WHISPER_MODEL=small on the container to use it. Every model baked in is proved at
# build time; WHISPER_MODELS chooses which (both, unless an image is built for one
# box that only ever uses one of them — `--build-arg WHISPER_MODELS=base` saves 190 MB).
ARG WHISPER_MODELS=base,small
ARG WHISPER_BASE_SHA256=422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898
ARG WHISPER_SMALL_SHA256=ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb

# A shallow fetch of one commit; `git clone --branch` only takes names.
RUN git init -q /tmp/whisper.cpp \
 && git -C /tmp/whisper.cpp fetch -q --depth 1 https://github.com/ggml-org/whisper.cpp "$WHISPER_CPP_COMMIT" \
 && git -C /tmp/whisper.cpp checkout -q FETCH_HEAD

ENV WHISPER_CMAKE="-DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_STATIC=ON -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF \
  -DWHISPER_BUILD_EXAMPLES=ON -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF -DWHISPER_SDL2=OFF -DWHISPER_CURL=OFF"

RUN set -e; mkdir -p /app/whisper; \
  case "$(uname -m)" in \
    x86_64) \
      cmake -S /tmp/whisper.cpp -B /tmp/wb3 $WHISPER_CMAKE -DGGML_SSE42=ON -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON \
        && cmake --build /tmp/wb3 --target whisper-cli -j"$(nproc)" \
        && cp /tmp/wb3/bin/whisper-cli /app/whisper/whisper-cli-v3; \
      cmake -S /tmp/whisper.cpp -B /tmp/wb2 $WHISPER_CMAKE -DGGML_SSE42=ON -DGGML_AVX=OFF -DGGML_AVX2=OFF -DGGML_FMA=OFF -DGGML_F16C=OFF \
        && cmake --build /tmp/wb2 --target whisper-cli -j"$(nproc)" \
        && cp /tmp/wb2/bin/whisper-cli /app/whisper/whisper-cli-v2;; \
    aarch64) \
      cmake -S /tmp/whisper.cpp -B /tmp/wb $WHISPER_CMAKE -DGGML_CPU_ARM_ARCH=armv8-a \
        && cmake --build /tmp/wb --target whisper-cli -j"$(nproc)" \
        && cp /tmp/wb/bin/whisper-cli /app/whisper/whisper-cli;; \
    *) echo "no whisper build for $(uname -m)" && exit 1;; \
  esac; \
  rm -rf /tmp/wb /tmp/wb2 /tmp/wb3 /tmp/whisper.cpp

# Each model named in WHISPER_MODELS is fetched and checked against its pinned digest;
# a name this file has no digest for fails the build rather than fetching something
# unchecked, and an empty list fails it too.
RUN set -e; \
  for model in $(printf '%s' "$WHISPER_MODELS" | tr ',' ' '); do \
    case "$model" in \
      base) sum="$WHISPER_BASE_SHA256";; \
      small) sum="$WHISPER_SMALL_SHA256";; \
      *) echo "WHISPER_MODELS names \"$model\", which this Dockerfile has no digest for (it knows base and small)." >&2; exit 1;; \
    esac; \
    wget -qO "/app/whisper/ggml-$model-q5_1.bin" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$model-q5_1.bin" \
      && echo "$sum  /app/whisper/ggml-$model-q5_1.bin" | sha256sum -c -; \
  done; \
  ls /app/whisper/ggml-*.bin >/dev/null 2>&1 || { echo "WHISPER_MODELS=\"$WHISPER_MODELS\" baked no model into the image." >&2; exit 1; }

# ---------------------------------------------------------------------------
# Runtime stage
# ---------------------------------------------------------------------------
# The same digest as the build stage; bump both together (see the top of the file).
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

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

# Owned by the default PUID/PGID from the start, so a container run with the defaults
# never has to chown the 4,500 files in here at boot (docker/entrypoint.sh).
COPY --from=build --chown=1000:1000 /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/whisper ./whisper
COPY src ./src
COPY docker ./docker
# Ships the admin-password reset, which is the only way back into an instance whose
# generated password has scrolled out of the container log.
COPY scripts ./scripts

# Proves every whisper binary against *this* image's libraries on a one-second file.
# A broken build fails here, not on the NAS after the update has been applied.
RUN node docker/whisper-smoke.mjs

# The model the container uses unless WHISPER_MODEL says otherwise. It has to be one of
# the models baked in: an image whose default model is missing would start, say the
# recogniser is unavailable, and publish every episode unheard. So the build refuses.
ARG WHISPER_DEFAULT_MODEL=base
RUN test -f "/app/whisper/ggml-${WHISPER_DEFAULT_MODEL}-q5_1.bin" \
 || { echo "WHISPER_DEFAULT_MODEL=${WHISPER_DEFAULT_MODEL} is not among the models baked in ($(ls /app/whisper | grep '^ggml-' | tr '\n' ' ')). Add it to WHISPER_MODELS, or set WHISPER_DEFAULT_MODEL to one of them." >&2; exit 1; }

RUN chmod +x docker/entrypoint.sh \
 && mkdir -p /data \
 && chown selfpod:selfpod /app

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    PUID=1000 \
    PGID=1000 \
    WHISPER_MODEL=${WHISPER_DEFAULT_MODEL}

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
      # mpg123-decoder) so that SelfPod can compare what two episodes sound like, and
      # whisper.cpp with an OpenAI Whisper model (both MIT) so that it can hear the
      # words. THIRD-PARTY-LICENSES.md says what that obliges and how it is met.
      org.opencontainers.image.licenses="MIT AND LGPL-2.1-or-later"
