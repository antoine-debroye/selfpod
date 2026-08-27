# SelfPod — Self-Hosted Podcast Server

## Specification for implementation

This document specifies a single-container, self-hosted application that
turns folders of audio files into private podcast RSS feeds, with a proper
web UI, automatic detection of new episodes, and no host-level scripting,
cron jobs, or manual permission fixes required.

It is written from direct, hard-won experience running a hand-rolled
version of this on TrueNAS: every requirement below exists because the
manual version hit that exact problem. Section 13 ("Lessons this design is
built from") explains the reasoning behind each non-obvious decision.

---

## 1. Goals

- Drop audio files into a folder (any way: SMB, NFS, `docker cp`, the web
  UI's own upload button) and have them appear as podcast episodes
  automatically, within seconds to a couple of minutes, with **no
  restart, no cron job, no manual regenerate step**.
- Support multiple audio formats out of the box: `.mp3`, `.m4a`, `.aac`,
  `.ogg`, `.opus`, `.wav`, `.flac` — never require the user to convert
  anything.
- Support multiple shows from one mounted directory, auto-discovered —
  adding a new show should never require editing `docker-compose.yml` or
  adding a new volume mount.
- A real web UI for everything: show metadata, cover art upload, episode
  list/edit, feed URLs with QR codes, activity log, health/diagnostics.
  Nothing should require SSH, editing YAML/JSON by hand, or reading log
  files to operate day-to-day.
- Be resilient to the permissions reality of NAS/homelab environments
  (SMB shares, ZFS NFSv4 ACLs, arbitrary container UIDs) by design, not
  by the user running ad hoc `chmod`/ACL commands after something breaks.
- Produce feeds that behave correctly in real podcast apps: stable GUIDs,
  correct MIME types, correctly percent-encoded URLs, HTTP Range support
  for scrubbing, valid iTunes-namespace tags, artwork validated against
  Apple's real requirements.
- Ship as one Docker image, one volume, sane defaults, works the same on
  TrueNAS, Unraid, Synology, a bare VPS, or plain `docker run`.

## 2. Non-goals

- Not a podcast *discovery* platform, not a public directory, not
  multi-tenant/multi-user. One admin account per instance.
- Not a transcoding/normalization pipeline. Files are served as uploaded
  (format support means "serve correctly," not "convert").
  - **Amended in 1.6.0.** SelfPod can remove approved stretches of audio
    from an MP3 and serve the shortened copy (§19). This is not
    transcoding and the distinction is not a quibble: nothing is decoded
    and nothing is re-encoded, so what is served is byte-identical to the
    original outside the cut. An MP3 is a sequence of self-contained
    frames — which is why a podcast host can stitch an advert onto one
    mid-response — and removing a stretch is removing frames and joining
    what remains. The original is never modified; the copy lives with the
    other derived caches and can be deleted for nothing but the CPU to
    rebuild it.
- Not a podcast *client* — no playback history, no listening, no library
  of other people's shows. This app produces feeds; listening happens in
  the user's existing podcast app.
  - **Amended in 1.6.0.** SelfPod can now follow a remote feed and
    download the episodes matching a filter into a show folder (§18).
    That is deliberately *not* a client: nothing is played here, no
    played state is kept, and the downloaded file is treated as exactly
    what it would be if it had arrived over SMB. It is a third way for a
    file to land in a folder, alongside the share and the upload button.
    The distinction matters because it is what keeps the rest of this
    specification unchanged — §6, §7 and §8 apply to a downloaded
    episode without a single exception.
- Not responsible for TLS termination or the public reverse
  proxy/tunnel — this app runs plain HTTP internally, same as any other
  self-hosted service; the user's existing reverse proxy (Caddy, Traefik,
  nginx, Cloudflare Tunnel, etc.) handles HTTPS.

---

## 3. High-level architecture

Single Docker container running four cooperating parts inside one
process (or a small number of processes managed by the container's
entrypoint, e.g. via a lightweight process supervisor):

1. **Web server** — serves the admin UI, the JSON API, the RSS feeds, and
   the media files, all from one HTTP port.
2. **Library scanner / watcher** — discovers shows and episodes on disk,
   extracts metadata, keeps the database in sync with the filesystem.
3. **Scheduler** — runs the periodic fallback rescan (see §8) and any
   other timed jobs, entirely inside the container. No host cron
   involved, ever.
4. **SQLite database** — the single source of truth for show/episode
   metadata overrides, stable GUIDs, feed tokens, admin credentials, and
   scan history. Lives on the same persistent volume as the media.

```
┌─────────────────────────────────────────────────────────┐
│ Container                                                │
│                                                           │
│  ┌───────────┐   ┌───────────────┐   ┌────────────────┐ │
│  │ Web server│   │   Scheduler   │   │ Library scanner│  │
│  │ (HTTP :80)│◄──┤ (interval +   ├──►│  + fs watcher  │  │
│  │           │   │  fs events)   │   │                │  │
│  └─────┬─────┘   └───────────────┘   └───────┬────────┘  │
│        │                                     │           │
│        └───────────────┬─────────────────────┘           │
│                         ▼                                │
│                  ┌─────────────┐                         │
│                  │   SQLite    │                         │
│                  │  (metadata) │                         │
│                  └─────────────┘                         │
└─────────────────────────┬─────────────────────────────────┘
                           │
                  ┌────────┴────────┐
                  │  /data (volume) │
                  │  /data/shows/*  │
                  │  /data/db.sqlite│
                  └─────────────────┘
```

## 4. Recommended tech stack

Not mandatory, but this combination keeps the container small, avoids a
separate frontend build pipeline, and has mature libraries for every hard
part of this problem:

| Concern | Choice | Why |
|---|---|---|
| Runtime | Node.js (LTS) | Single language for server + tooling |
| Web framework | Fastify or Express | Either is fine; Fastify is faster |
| Templates / UI | Server-rendered (EJS or similar) + [htmx](https://htmx.org) + Pico.css or Tailwind (precompiled, no build step at runtime) | Real interactivity without a SPA build pipeline inside the container |
| Database | SQLite via `better-sqlite3` | Zero external dependency, file-based, trivial to back up |
| File watching | `chokidar` | Cross-platform, handles the network-share edge cases better than raw `fs.watch` |
| Audio metadata | `music-metadata` (pure JS, no ffmpeg dependency) as primary, with optional `ffprobe` if present in the image for anything `music-metadata` can't parse | Avoids requiring ffmpeg for the common case |
| Image processing | `sharp` | Validate/resize/normalize cover art |
| RSS/XML building | Hand-rolled with a proper XML builder (`xmlbuilder2`) — do **not** use string concatenation | Correctness for escaping and namespaces |
| Auth | `express-session`/`fastify-session` + bcrypt for the admin account; random opaque tokens for feed URLs | Simple, no external identity provider needed |

If Claude Code prefers Python (FastAPI) or Go, the same architecture and
schema apply — the stack table is a recommendation, not a hard
requirement. The rest of this spec is language-agnostic.

---

## 5. Volume & directory layout

**This is the single biggest simplification over a hand-rolled setup.**
One directory, auto-discovered — no per-show volume mounts, ever.

```
/data                           <- one Docker volume, mounted once
├── db.sqlite                   <- app database (created on first run)
├── config.json                 <- instance-level settings (see §9)
└── shows/
    ├── my-daily-show/          <- one subfolder = one show, auto-discovered
    │   ├── show.json           <- optional metadata override (auto-created)
    │   ├── cover.jpg            <- cover art, any common image ext (see §10.4)
    │   ├── 2026-08-07-episode-one.m4a
    │   ├── 2026-08-08-episode-two.mp3
    │   └── .episodes.json      <- internal cache, not user-edited
    └── another-show/
        ├── cover.png
        └── ep001.mp3
```

Requirements:

- The app watches `/data/shows/*` (one level deep) for directories. Each
  directory becomes a show automatically — **creating a new show is
  "make a folder," full stop.** The web UI also offers a "New show"
  button that creates the folder for users who don't want to touch the
  filesystem at all.
- Deleting a show's folder removes it from the UI and feed list (with a
  confirmation step in the UI before the underlying DB rows are purged —
  see §11.6).
- Any file directly inside a show folder with a supported audio
  extension (§6.1) is an episode candidate. Subdirectories inside a show
  folder are ignored (reserved for future season/series support).
- `show.json` is optional. If absent, the app synthesizes sane defaults
  (title = folder name, humanized; author = instance-level default
  author from `config.json`; language = instance default) and will write
  a `show.json` back to disk once the user edits anything via the UI, so
  the config is portable/version-controllable if the user wants that.

---

## 6. Library scanning

### 6.1 Supported audio formats

| Extension | MIME type used in `<enclosure type="">` |
|---|---|
| `.mp3` | `audio/mpeg` |
| `.m4a` | `audio/x-m4a` |
| `.aac` | `audio/aac` |
| `.ogg` | `audio/ogg` |
| `.opus` | `audio/opus` |
| `.wav` | `audio/wav` |
| `.flac` | `audio/flac` |

MIME type table must be centralized in one place in the codebase (a
single constant map), not duplicated between the scanner and the feed
generator — this exact duplication caused a real bug during manual
development of the prototype this spec replaces.

### 6.2 Detection: watcher + polling fallback (important)

**Do not rely on filesystem events alone.** Real-world deployments mount
`/data` from network shares (SMB/NFS/CIFS) where `inotify` events are
frequently **not** delivered reliably, or are delivered with a long
delay, because the writes happen on a remote host. A design that only
reacts to `fs.watch`/`chokidar` events will silently miss episodes for
some fraction of users and there will be no error to see — the episode
just never appears. This exact failure mode is why the manual prototype
needed a cron job at all.

Required behavior:

1. **Primary path:** file-system watcher (`chokidar`, polling mode
   available as a fallback option — see below) on `/data/shows`, debounced
   (e.g. 2–5 seconds after the last change in a directory) before
   triggering a rescan of that show, so a multi-file copy doesn't trigger
   N redundant scans.
2. **Fallback path:** an internal scheduled rescan of the entire library,
   default every 5 minutes, configurable in the UI (range: 1 minute to 6
   hours). This is what actually guarantees correctness on network
   shares, and must exist even if the watcher works perfectly on a given
   host.
3. Expose a **"Rescan now"** button in the UI (global and per-show) that
   triggers an immediate scan and shows a live progress indicator (via
   Server-Sent Events or polling) rather than a silent background action.
4. If the watcher backend detects it isn't receiving events at all after
   startup (e.g. `chokidar`'s `usePolling` diagnostic, or simply: no
   events observed for N minutes while polling detects a change), the
   app should automatically fall back to polling mode for that mount and
   surface a one-time notice in the UI: *"Live file detection isn't
   available on this volume — using periodic scanning every N minutes
   instead."* This must never be a silent failure.

### 6.3 What a scan does, per show folder

1. List files matching supported extensions (§6.1) directly in the show
   folder.
2. For each file not already known (matched by §7.2 identity rule):
   - Extract duration, bitrate, and file size.
   - Attempt tag-based title/description if embedded (ID3/MP4 tags) —
     used only as a *suggested* title if the user hasn't set one, never
     silently overwrites a user-edited title on rescan.
   - Compute/assign a stable GUID (§7.2).
   - Insert into the database with `pub_date` defaulting to file mtime.
3. For each file previously known but no longer present on disk, mark
   the episode `missing` (soft state, not deleted) rather than removing
   it from the feed immediately — avoids apps re-downloading/duplicating
   if a network share blips and a file is briefly invisible. A file
   missing for more than a configurable grace period (default 24 hours)
   is then fully removed and the episode dropped from the feed.
4. Detect the cover image (§10.4) for the show.
5. Write a scan-result summary to the activity log (§11.5): files found,
   added, updated, missing, and any errors (unreadable file, permission
   denied, duration extraction failed, etc.) — **with enough detail that
   the user never needs to open a terminal to understand what happened.**

---

## 7. Data model (SQLite schema)

```sql
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- rows include: public_base_url, default_author_name, default_author_email,
-- default_language, rescan_interval_seconds, admin_password_hash, etc.

CREATE TABLE shows (
  id                TEXT PRIMARY KEY,        -- stable, generated once (uuid)
  slug              TEXT UNIQUE NOT NULL,    -- folder name; used in URLs
  title             TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  author_name       TEXT NOT NULL,
  author_email      TEXT NOT NULL,
  language          TEXT NOT NULL DEFAULT 'en',
  itunes_category   TEXT NOT NULL DEFAULT 'Technology',   -- from Apple's category list, see §10.5
  itunes_subcategory TEXT,
  explicit          INTEGER NOT NULL DEFAULT 0,           -- boolean
  cover_filename    TEXT,                                 -- e.g. "cover.jpg"; NULL if none detected
  feed_token        TEXT UNIQUE NOT NULL,                 -- random, for private feed URL, see §12.2
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE episodes (
  id                TEXT PRIMARY KEY,        -- stable guid, see §7.2
  show_id           TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  filename          TEXT NOT NULL,           -- current filename on disk
  identity_key      TEXT NOT NULL,           -- see §7.2, used to match across renames
  title             TEXT NOT NULL,
  title_is_custom   INTEGER NOT NULL DEFAULT 0, -- if 1, scanner must never overwrite title
  description       TEXT NOT NULL DEFAULT '',
  season            INTEGER,
  episode_number    INTEGER,
  explicit          INTEGER,                 -- NULL = inherit from show
  pub_date          TEXT NOT NULL,           -- ISO 8601
  pub_date_is_custom INTEGER NOT NULL DEFAULT 0,
  duration_seconds  INTEGER,                 -- NULL if extraction failed
  file_size_bytes   INTEGER NOT NULL,
  mime_type         TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active', -- active | missing | removed
  missing_since     TEXT,                    -- set when status becomes 'missing'
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE(show_id, identity_key)
);

CREATE TABLE scan_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  show_id     TEXT REFERENCES shows(id) ON DELETE CASCADE, -- NULL = global scan
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  trigger     TEXT NOT NULL,     -- 'watcher' | 'scheduled' | 'manual'
  files_found INTEGER,
  added       INTEGER,
  updated     INTEGER,
  missing     INTEGER,
  errors_json TEXT               -- JSON array of {file, message}
);
```

### 7.1 Why SQLite, not YAML/JSON-per-show as the source of truth

The manual prototype stored config in per-show YAML and had no database
at all — every piece of state (which files exist, their GUIDs, whether
the user edited a title) had to be re-derived from the filesystem on
every run, which is exactly what caused GUID instability (§7.2) and made
"did the user customize this title" impossible to know. A real database
is required so user edits and file-derived data can coexist without one
clobbering the other.

`show.json` on disk (§5) is a *convenience export/import* of the show-level
settings for portability, not the runtime source of truth — the database is
authoritative; `show.json` is written out after changes and read once
at first discovery of a show that doesn't yet have a database row.

### 7.2 Stable GUID / identity strategy (important — real bug in the prototype)

The hand-rolled prototype derived each episode's GUID from
`sha1(show_id + "/" + filename)`. This is broken: **renaming a file
changes its GUID**, which most podcast apps treat as an entirely new
episode — users lose listened/played state and get a duplicate in their
feed. Do not repeat this.

Required approach:

- `identity_key` = a hash of **content**, not filename: for files under
  some reasonable size threshold (e.g. 200MB), hash the first + last 1MB
  of the file plus its total size (fast, avoids reading a multi-hour
  file in full, still effectively unique for this use case). For larger
  files, hashing the same fixed-size head/tail window is fine — full
  duplication is not a realistic concern for a personal podcast library.
- On scan, look up existing episodes for the show by `identity_key`
  first. If found, update `filename` (if it changed) but **keep the
  existing `id` (GUID)** and all user-edited fields untouched.
- Only generate a new `id` (a fresh random UUID, not derived from
  anything about the file) when no matching `identity_key` exists —
  i.e., a genuinely new file.
- This means: renaming a file on disk updates the episode's filename in
  the feed's `<enclosure url>` but does **not** change its `<guid>`, so
  podcast apps correctly treat it as the same episode.

---

## 8. RSS feed generation

### 8.1 Generation model: on-demand, not scheduled writes to disk

The manual prototype wrote XML files to disk on a timer and had the web
server statically serve them — this is the direct cause of every "why
isn't my update showing up" problem in this whole project: the feed was
only ever as fresh as the last cron run, and nothing surfaced *when*
that had last happened.

**Generate the RSS XML dynamically on every request to the feed
endpoint**, reading current state from the database (which the
watcher/scheduler keeps in sync per §6). This eliminates the entire
class of "stale until next scheduled run" problems:

- Add a short in-memory cache (e.g. 30–60 seconds) keyed by show id, to
  avoid rebuilding XML on every single request from a busy podcast app's
  polling — but the cache must be invalidated immediately whenever the
  scanner detects a change for that show, not just on a fixed TTL. This
  gives "instant after a change, cheap otherwise."
- No file is ever written to `/data` for the feed itself. This also
  removes an entire category of permission problems the prototype had
  (needing write access to a folder just to publish read-only feed XML).

### 8.2 Feed URL structure

```
{PUBLIC_BASE_URL}/feeds/{show-slug}/{feed_token}.xml
```

- `feed_token` (§12.2) makes the URL unguessable without requiring the
  podcast app itself to support HTTP auth (most don't handle Basic Auth
  well in practice). Rotatable from the UI if a URL leaks.
- `show-slug` is present for human readability/debuggability; the token
  is what actually authorizes access. If the slug and token don't match
  the same show, return 404 (don't leak whether a slug exists).

### 8.3 Required feed content

Full RSS 2.0 + iTunes namespace + Podcast namespace (2.0) tags:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
     xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
     xmlns:podcast="https://podcastindex.org/namespace/1.0"
     xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>{show.title}</title>
    <link>{PUBLIC_BASE_URL}</link>
    <description>{show.description}</description>
    <language>{show.language}</language>
    <itunes:author>{show.author_name}</itunes:author>
    <itunes:owner>
      <itunes:name>{show.author_name}</itunes:name>
      <itunes:email>{show.author_email}</itunes:email>
    </itunes:owner>
    <itunes:category text="{show.itunes_category}">
      <itunes:category text="{show.itunes_subcategory}"/> <!-- if set -->
    </itunes:category>
    <itunes:explicit>{show.explicit ? 'true' : 'false'}</itunes:explicit>
    <itunes:image href="{cover URL, see §10}"/>
    <image>
      <url>{cover URL}</url>
      <title>{show.title}</title>
      <link>{PUBLIC_BASE_URL}</link>
    </image>
    <podcast:locked>yes</podcast:locked>
    <podcast:guid>{a stable, show-level UUID, generated once at show creation}</podcast:guid>
    <generator>Podhost</generator>
    <lastBuildDate>{RFC 2822}</lastBuildDate>

    <item>
      <title>{episode.title}</title>
      <description>{episode.description}</description>
      <guid isPermaLink="false">{episode.id}</guid>
      <pubDate>{episode.pub_date, RFC 2822}</pubDate>
      <itunes:duration>{HH:MM:SS, only if known}</itunes:duration>
      <itunes:explicit>{resolved explicit flag}</itunes:explicit>
      <itunes:season>{episode.season}</itunes:season>       <!-- only if set -->
      <itunes:episode>{episode.episode_number}</itunes:episode> <!-- only if set -->
      <enclosure url="{percent-encoded media URL, see §8.4}"
                 length="{episode.file_size_bytes}"
                 type="{episode.mime_type}"/>
    </item>
    <!-- newest episode first -->
  </channel>
</rss>
```

Hard requirements, each corresponding to a real bug hit while building
the prototype by hand:

1. **All URLs must be built with a proper URL/percent-encoding
   function** (encode the path segment, not the whole URL) — never
   string-concatenate a raw filename into a URL. A filename containing
   spaces, accented characters, emoji, or curly quotes must produce a
   syntactically valid URL. Test with a filename containing all four.
2. **`<guid isPermaLink="false">`** — always explicit, never omit
   `isPermaLink` (some apps default it to `true` and then try to treat
   the guid as a fetchable URL).
3. Only emit `<itunes:duration>` when duration extraction succeeded;
   omitting the tag is correct, do not emit `0` or an empty tag.
4. `pubDate`/`lastBuildDate` must be valid RFC 2822 (most XML/date
   libraries have a helper for this; do not hand-format it).
5. All text content (title, description, author) must go through the
   XML library's text-escaping — never assume input is already
   XML-safe, since titles come from filenames/user input.

### 8.4 Media URL structure & serving

```
{PUBLIC_BASE_URL}/media/{show-slug}/{feed_token}/{episode-id}/{url-encoded-filename}
```

- Routed by `episode-id` (stable), not by trusting the filename in the
  URL for lookup — the filename suffix is included only so podcast apps
  that infer file extensions from the URL behave correctly, and so
  downloaded files have a sensible name. The server resolves the actual
  file path from the database via `episode-id`, and 404s if the token
  doesn't match the show.
- **Must support HTTP Range requests** (`Accept-Ranges: bytes`, honor
  `Range` headers, return `206 Partial Content`) — required for seeking
  and for some podcast apps' download-resume behavior. Most web
  frameworks have a static/stream helper that does this correctly; don't
  hand-roll range parsing.
- Set `Content-Type` from the centralized MIME map (§6.1), never sniff.
- Set `Content-Length` from the actual file size at request time (not a
  cached/stale value).
- Reasonable cache headers (e.g. `Cache-Control: public, max-age=86400`)
  are fine for media files since episode files, once published, don't
  change — but see §13.4 for a caution about *cover art* caching
  specifically, which does change.

---

## 9. Configuration (environment variables)

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PUBLIC_BASE_URL` | Yes | — | e.g. `https://podcast.example.com` — used to build every URL in every feed. Must include scheme, no trailing slash. |
| `PORT` | No | `8080` | Internal HTTP port |
| `PUID` | No | `1000` | UID the app runs as inside the container — see §13.1 |
| `PGID` | No | `1000` | GID the app runs as inside the container |
| `TZ` | No | `UTC` | Used for displaying dates in the UI and default `pubDate` when a file has no reliable mtime |
| `RESCAN_INTERVAL_SECONDS` | No | `300` | Fallback polling interval (§6.2); overridable per-instance in the UI, this is just the initial default |
| `ADMIN_USERNAME` | No | `admin` | Bootstrap admin username, only used on first run |
| `ADMIN_PASSWORD` | First run only | — | If unset on first run, a random password is generated and printed once to container logs, and the UI forces a password change on first login. Never store or accept a default/blank password silently. |
| `SESSION_SECRET` | No | random, generated on first run and persisted in the DB | Signs admin session cookies |
| `LOG_LEVEL` | No | `info` | `debug`/`info`/`warn`/`error` |
| `MAX_UPLOAD_SIZE_MB` | No | `1024` | Cap for UI-based file uploads (§11.4) |

Only one required volume:

```yaml
services:
  podhost:
    image: yourname/podhost:latest
    environment:
      - PUBLIC_BASE_URL=https://podcast.example.com
      - PUID=1000
      - PGID=1000
      - TZ=Europe/London
    volumes:
      - /path/on/host/podcast-data:/data
    ports:
      - "8080:8080"
    restart: unless-stopped
```

That's the entire `docker-compose.yml` a user needs, regardless of how
many shows they add later — no editing this file to add a show, ever.

---

## 10. Cover art handling

### 10.1 Detection

Accept **any** of these filenames, case-insensitive, checked in this
order, first match wins: `cover.jpg`, `cover.jpeg`, `cover.png`,
`cover.webp`, `folder.jpg`, `artwork.jpg`. (The prototype broke silently
the first time a user's file happened to be `cover.png` instead of
`cover.jpg` — support the common variants from day one instead of one
hardcoded filename.)

Also accept upload directly through the UI (§11.4), which always writes
to `cover.jpg` in the show's folder (converting format if necessary via
`sharp`) so filesystem-based and UI-based cover management stay
consistent.

### 10.2 Validation & normalization

On detection of a new/changed cover image:

- Read actual dimensions and format.
- If not square, or outside 1400–3000px per side (Apple Podcasts'
  documented requirements), **do not block anything** — the feed still
  works — but surface a clear, specific warning in the UI on that show's
  page: *"Cover art is 200×200px. Podcast directories typically require
  1400–3000px, square. This may look pixelated when subscribers view
  the full-size artwork."* Include the actual detected dimensions in the
  message, not a generic warning.
- Optionally (nice-to-have, not required for MVP): offer a one-click
  "resize/pad to 1400×1400" action in the UI using `sharp`, writing the
  result back as `cover.jpg`.

### 10.3 Serving

```
{PUBLIC_BASE_URL}/media/{show-slug}/{feed_token}/cover.jpg
```

- Served with `Cache-Control: public, max-age=3600` (one hour) — **short**,
  deliberately, not the long cache duration used for episode audio.
  Cover art does change (users update it), and long caching at any CDN
  or reverse proxy in front of this app caused real confusion in the
  prototype (Cloudflare served a 24-hour-stale image after an update).
  A short max-age keeps updates propagating quickly through any CDN/proxy
  layer without needing manual cache purges.
- Also add `ETag` (hash of the file) and honor `If-None-Match`, so
  well-behaved caches still avoid re-downloading unchanged art despite
  the short max-age.

### 10.4 The real limits of this app's control (document this for users)

Include a permanent, visible note in the UI's help/docs section:
podcast apps (Pocket Casts, Apple Podcasts, etc.) commonly cache
artwork **on their own servers**, keyed to their internal podcast ID,
independent of this app's cache headers entirely, and only refresh it
on their own schedule. This app cannot force a third-party podcast
app's backend to refresh faster. Document this plainly so users don't
spend hours debugging their own server when the server is already
correct — this exact confusion is the direct motivation for this note.

---

## 11. Web UI

### 11.1 Pages

| Route | Purpose |
|---|---|
| `/` | Dashboard: list of shows (cover thumbnail, title, episode count, last scan time, any warnings) |
| `/setup` | First-run wizard: set admin password, set `PUBLIC_BASE_URL` (pre-filled from env if provided, editable), default author name/email/language |
| `/shows/new` | Create a new show (name → creates folder + DB row) |
| `/shows/:slug` | Show detail: metadata form, cover art upload/preview, feed URL + QR code, episode list |
| `/shows/:slug/episodes/:id` | Episode edit: title, description, season/episode number, explicit override, publish date override |
| `/shows/:slug/upload` | Drag-and-drop upload of new audio files directly through the browser (§11.4) |
| `/settings` | Instance-level settings: default author/email/language, rescan interval, admin password change, session/security settings |
| `/activity` | Scan history and errors (§11.5), filterable by show |
| `/login`, `/logout` | Admin auth |

### 11.2 Dashboard requirements

- Each show card shows a **status indicator**: green ("last scan
  succeeded, N episodes") vs. yellow/red ("last scan had N errors — view
  details") — errors must never be something the user only discovers by
  a podcast app failing to download an episode. Surface it here first.
- A global "Rescan all" button.
- A visible "Public base URL: {value}" with a one-click "test it" that
  fetches `{PUBLIC_BASE_URL}/health` from the browser and reports
  success/failure — catches misconfigured reverse-proxy/DNS setups
  immediately instead of only discovering it when a podcast app fails.

### 11.3 Show detail page requirements

- Metadata form (title, description, author name/email, language,
  category/subcategory picker populated from Apple's official category
  list — not free text, to avoid typos producing an invalid category),
  explicit toggle.
- Cover art: current image preview, drag-and-drop replace, dimension/
  validation warning inline (§10.2).
- Feed URL shown in full, with a copy-to-clipboard button and a
  rendered QR code (scannable directly from a phone's podcast app "add
  by URL" flow, or a camera app).
- "Rotate feed token" button (with a confirm step, since it invalidates
  the old URL for anyone already subscribed).
- Episode list: table with title, publish date, duration, file size,
  status (active/missing), and inline actions (edit, delete from
  feed only vs. delete file too — these must be two clearly distinct
  actions, since deleting the underlying file is destructive and
  irreversible).
- Reordering is **not** needed — order is always by publish date,
  descending. Publish date is editable per-episode if a user wants to
  reorder effectively.

### 11.4 Upload flow (optional path alongside filesystem drop)

- Drag-and-drop or file-picker upload of one or more audio files
  directly to a show, entirely through the browser — for users who don't
  want to set up SMB/NFS access at all, or who are on a device without
  filesystem access to the server.
- Server validates extension against §6.1 before accepting, streams the
  upload to a temp location inside `/data`, then moves it into the show
  folder on success — never accept a partial/failed upload as a valid
  episode file.
- After upload completes, trigger an immediate scan of that show (don't
  make the user wait for the next scheduled rescan).

### 11.5 Activity log

- Reverse-chronological list of scans (`scan_log` table), each entry
  expandable to show the full error list for that scan.
- Each error entry is a plain-language sentence, not a raw stack trace:
  e.g. *"Could not read `episode-42.wav`: permission denied. Podhost is
  running as UID {PUID}; check that this user can read files in
  `{path}`."* — actionable, specific, references the actual configured
  PUID so the user knows exactly what to fix. This is the single most
  important UX requirement in this whole spec: **every failure mode
  encountered while building the prototype by hand was invisible until
  a podcast app failed** — this log is what prevents that class of
  problem from recurring.

### 11.6 Destructive action confirmation

Any action that deletes data (remove show, delete episode file, rotate
feed token) requires an explicit confirmation step in the UI (type the
show name to confirm, or a standard "Are you sure?" modal for
lower-stakes actions) — never a single click.

---

## 12. Authentication & security

### 12.1 Admin UI

- Single admin account (username + bcrypt-hashed password), session
  cookie–based auth, `HttpOnly` + `Secure` (when served over HTTPS,
  which it will be, behind the user's reverse proxy) + `SameSite=Lax`.
- No self-registration, no multi-user support (see Non-goals, §2).
- Rate-limit login attempts (e.g. 5 attempts per 15 minutes per IP).

### 12.2 Feed & media access

- Not protected by the admin session — podcast apps can't do interactive
  login. Instead, each show has a random `feed_token` (≥ 128 bits of
  entropy, e.g. a UUIDv4 or 22-character base62 string) embedded in
  every feed and media URL for that show (§8.2, §8.4). Treat the token
  as the credential: anyone with a show's feed URL can access that
  show's feed and media, and only that show's.
- Token is rotatable per-show from the UI (§11.3) without affecting
  other shows.
- No global "shared secret" — a leaked token only exposes one show, not
  the whole library.

### 12.3 Health check endpoint

`GET /health` — unauthenticated, returns `200 OK` with a minimal JSON
body (`{"status":"ok","version":"..."}`). Used by Docker `HEALTHCHECK`,
the dashboard's "test it" button (§11.2), and any external uptime
monitor.

---

## 13. Lessons this design is built from

Concrete failures hit while running a hand-built version of this system
manually, and the specific design decision above that prevents each one:

1. **The generator only supported `.mp3`, silently ignoring `.m4a`
   files** with no error or warning anywhere — an entire episode simply
   never appeared in the feed. → §6.1 requires a defined multi-format
   table from day one, and §6.3/§11.5 require every scan outcome
   (including "file found but unsupported/unparseable") to be visible in
   the UI, never silent.

2. **Feed URLs contained raw, non-percent-encoded filenames** (spaces,
   emoji, curly quotes), which some clients/tools rejected outright. →
   §8.3 requirement 1 mandates a proper URL-encoding function, tested
   against exactly this class of filename.

3. **Cover art detection hardcoded to exactly `cover.jpg`**, so a file
   saved as `cover.png` was silently ignored with the show's artwork
   just... missing, no error. → §10.1 requires checking a list of common
   filenames, and §6.3 requires scan results to be visible so a mismatch
   like this would show up immediately instead of requiring the user to
   notice artwork is missing in their podcast app days later.

4. **File permissions**: the underlying storage used ZFS NFSv4 ACLs,
   which don't map cleanly onto the plain POSIX UID/GID model a
   container process uses, and computed POSIX mode bits were `0000` —
   readable by nobody except root — even though the ACL "looked" fine
   in a GUI. The container had no way to detect or report this; the only
   symptom was every episode download failing with 403, discovered only
   when a podcast app tried to download an episode. → §13.1 requires a
   PUID/PGID pattern (matching the well-established convention from
   images like linuxserver.io) so the *user* explicitly controls what
   UID the container runs as and can align it with their host
   permissions directly, rather than the app guessing; and §6.3/§11.5
   require permission errors to be caught per-file during scanning and
   surfaced as a specific, actionable message in the activity log and
   on the dashboard — not discovered externally via a failed download.

5. **Fixing the permission problem once (via a manual `chmod`) broke a
   completely different thing**: setting the folder to `0755` gave the
   container read access but silently removed the actual content
   owner's *write* access to the same folder, since the previous access
   was an ACL-based grant rather than derived from file ownership. →
   this is precisely why permission handling must be the *user's*
   explicit choice via PUID/PGID (matching their own account) rather
   than the app unilaterally rewriting filesystem permissions on the
   user's existing files — the app should never run `chmod`/ACL-editing
   commands against the user's media folders at all. If a permission
   problem is detected, the fix communicated to the user is "adjust
   PUID/PGID or your share's permissions to match," never an automatic
   in-place mutation of their filesystem.

6. **The feed was only as fresh as the last scheduled regeneration**,
   which required a container restart in the very first iteration of
   the prototype, then a cron job in a later iteration, with no way to
   know when it had last actually run without reading a debug log by
   hand over SSH. → §8.1's on-demand generation model removes the
   "stale until next scheduled run" failure class entirely; §11.2's
   dashboard status and §11.5's activity log make "when did this last
   update, and did it succeed" visible without SSH.

7. **GUIDs were derived from filename**, so renaming a file (or the
   generator changing how it built the GUID) changed every episode's
   identity from the podcast app's point of view. → §7.2 requires
   content-based identity, decoupled from filename, with GUIDs
   persisted in the database and never regenerated for a
   already-known file.

8. **Multiple separate volume mounts were required per show** (one for
   audio, plus separate mounts had to be added by hand for feed output
   files) in the container's configuration, meaning every new show meant
   editing the container's deployment config directly. → §5's single
   auto-discovered root directory removes this entirely: one volume,
   mounted once, forever.

9. **Third-party podcast apps cache artwork on their own infrastructure,
   independent of this app** — a correctly-serving origin server can
   still show broken artwork in a subscriber's app for reasons entirely
   outside this app's control. → §10.4 requires this to be documented
   plainly in the app's own UI, so users don't spend hours re-debugging
   a server that was already correct.

### 13.1 PUID/PGID implementation detail

At container startup (before the main process starts), the entrypoint
script must:

1. Read `PUID`/`PGID` from the environment (defaults `1000`/`1000`).
2. If the container's internal app user doesn't already have that
   UID/GID, adjust it (`usermod`/`groupmod`, standard pattern — see any
   linuxserver.io image's `init` scripts for reference).
3. Drop privileges to that UID/GID before running the actual
   application process (never run the long-lived app process as root).
4. On startup, attempt a read + write test against `/data` as that UID.
   If either fails, **do not silently continue** — log a clear error
   identifying the exact path and the exact UID/GID that failed, and
   surface a persistent banner in the web UI (which should still be
   reachable, even in this degraded state, so the user can see the
   error message without SSH) until resolved.

---

## 14. REST API (for the UI, and usable directly by advanced users)

All routes below `/api` except `/health` require the admin session
cookie unless noted.

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/health` | Unauthenticated health check |
| `POST` | `/api/setup` | First-run: set admin password + instance defaults |
| `POST` | `/api/login` | Authenticate |
| `POST` | `/api/logout` | End session |
| `GET` | `/api/shows` | List shows with summary stats |
| `POST` | `/api/shows` | Create a show (creates folder + DB row) |
| `GET` | `/api/shows/:id` | Show detail |
| `PATCH` | `/api/shows/:id` | Update show metadata |
| `DELETE` | `/api/shows/:id` | Delete a show (query param controls whether files are also deleted) |
| `POST` | `/api/shows/:id/cover` | Upload cover art (multipart) |
| `POST` | `/api/shows/:id/rotate-token` | Rotate feed token |
| `POST` | `/api/shows/:id/rescan` | Trigger immediate rescan |
| `GET` | `/api/shows/:id/episodes` | List episodes |
| `PATCH` | `/api/episodes/:id` | Update episode metadata |
| `DELETE` | `/api/episodes/:id` | Remove from feed (and optionally delete file, via query param) |
| `POST` | `/api/shows/:id/upload` | Upload one or more audio files (multipart) |
| `GET` | `/api/activity` | Scan log, paginated, filterable by show |
| `GET` | `/api/settings` | Instance settings |
| `PATCH` | `/api/settings` | Update instance settings |
| `GET` | `/feeds/:slug/:token.xml` | Public RSS feed (no auth, token-gated) |
| `GET` | `/media/:slug/:token/cover.jpg` | Public cover art (no auth, token-gated) |
| `GET` | `/media/:slug/:token/:episodeId/:filename` | Public episode audio (no auth, token-gated, Range-aware) |

All `PATCH`/`POST` mutating endpoints return the updated resource.
Errors return a consistent shape: `{"error": {"message": "...", "code": "..."}}`
with an appropriate HTTP status — the UI relies on `message` being
directly displayable to the user, so error messages must be written in
plain language, not raw exception text.

---

## 15. Docker packaging

- Single `Dockerfile`, small base image (e.g. `node:22-alpine`).
- `HEALTHCHECK` calling `GET /health`.
- Entrypoint script implements the PUID/PGID handling from §13.1 before
  `exec`-ing into the Node process (so signals propagate correctly for
  clean shutdown).
- Multi-arch build (`linux/amd64` and `linux/arm64`) — homelab users run
  a mix of both.
- Image should be usable with **zero required environment variables
  beyond `PUBLIC_BASE_URL`** — everything else has a documented,
  sensible default (§9).
- Ship a `docker-compose.yml` in the repo root as the canonical example
  (shown in §9), plus a short README section for TrueNAS/Unraid/Synology
  users specifically, since permission handling (§13) is the one place
  those platforms need slightly different guidance (documenting how to
  find the right PUID/PGID to set on each platform).

---

## 16. Suggested implementation phases

Not a rigid order, but a sensible sequence for an initial build:

1. **Core**: SQLite schema, folder auto-discovery, scanner (watcher +
   polling fallback), on-demand RSS generation, media serving with
   Range support. No UI yet — feeds work via curl.
2. **Auth + admin UI shell**: setup wizard, login, dashboard, show
   detail page (read-only first).
3. **Editing**: show metadata form, cover art upload, episode metadata
   editing, feed token rotation.
4. **Robustness**: activity log, permission self-test + UI banner,
   scan error surfacing, "test public URL" button.
5. **Polish**: QR codes, category picker, cover art dimension
   validation, upload-via-browser flow, multi-arch Docker build.

## 18. Following remote feeds

Off by default. With `subscriptions_enabled` unset, SelfPod makes exactly
the outbound requests it made before this feature existed — one, the
reachability self-check — so an install that never asks for this keeps
its previous security posture unchanged.

### 18.1 Reading a feed

A feed document is fetched, its bytes decoded using the charset the server
or the document declares, and refused outright if it carries a `DOCTYPE`.
Podcast feeds never need one, and every entity-expansion attack requires a
DTD to declare the entities it expands — refusing it removes the whole
class in a way no dependency upgrade can undo.

Entities are decoded in a single pass, so `&amp;amp;` becomes `&amp;` and
stops there: exponential expansion is unrepresentable rather than bounded.
Remote descriptions are reduced to plain text at ingest, because §8.3
emits `content:encoded` inside a CDATA section where markup is not
escaped, and republishing a stranger's HTML to the operator's own
subscribers is not acceptable.

### 18.2 Deciding what to take

Per subscription: a list of positive title keywords (any one is enough; an
empty list means no positive requirement), a list of negative keywords
(these always win), and an optional minimum and maximum duration.
Matching is case- and accent-insensitive substring matching on the title
only.

When a feed does not state an episode's length, the file is downloaded and
measured, and discarded if it falls outside the range. A length the feed
*did* state is trusted: re-checking it against the file would discard
episodes over a metadata discrepancy the user cannot see or fix.

Every item the feed lists is recorded with a decision and, for a refusal,
a sentence explaining it. "Why is that episode not in my feed?" must be
answerable, and the answer must be a sentence rather than a code.

### 18.3 Downloading

The file is staged inside the show folder under a dot-prefixed name (both
the scanner and the watcher skip those), validated, given the publication
date as its mtime, and only then moved into place. A batch is moved
together so one scan and one feed update cover the whole run.

Filenames are **generated, never adopted**: the extension comes from the
response's own content type, the stem from the publisher's title through
the same sanitising every upload gets, and the result is asserted portable
before it touches the filesystem. `Content-Disposition` is never consulted.

### 18.4 Reaching the network

Every address SelfPod connects to must be public unicast. The rules, and
the reasoning behind each, are documented in `src/lib/address-rules.js`
and `src/lib/guarded-fetch.js`. In summary: http/https only, port 80 or
443 only, no credentials in the URL, every address a name resolves to
checked, the connection pinned to the address that was checked, and the
whole check repeated at every redirect hop and every poll — never once, at
subscribe time, and then trusted.

Two holes are real and stated rather than hidden: a public host that
proxies inwards cannot be detected by any address rule, and SelfPod's own
public address resolves publicly like anyone else's. The first is why the
projection returned to the admin is a closed list of named fields; the
second is handled with a signed probe header.

### 18.5 What the admin may see

A bounded, name-by-name, length-clamped projection: feed title and
description, up to fifty episode titles with their dates and durations,
and the *host* of each enclosure. Never the raw body, never a response
header, never the redirect chain, never a resolved address, and never an
upstream error code — distinguishing "refused" from "timed out" is the
oracle that turns a blocked-address refusal into a working port scan.

### 18.6 Failure

A subscription that stops working is surfaced, never silently abandoned:
it backs off, and from the third consecutive failure raises a health
warning. A subscription whose *address* is refused is a different case —
it can never work as written, so it is stopped and reported rather than
retried every fifteen minutes for ever.

## 19. Removing adverts

### 19.1 What SelfPod will and will not decide

It finds audio a show repeats and audio that changes between two
downloads of one episode. It never decides that either is an advert. A
theme tune, a sponsor read, a standing intro and a recurring stinger all
repeat identically, and nothing in the audio separates them — so
everything found is offered, and the only thing automatic mode changes is
whether the owner is asked first.

### 19.2 Two detectors, one catalogue

**Repetition across a show's episodes** finds what was cut in at
production time, by comparing what the episodes *sound* like.

The first design compared MP3 frames byte for byte, on the belief that
a producer dropping the same audio into an edit yields the same encoded
frames. That was wrong, and the measurement is worth keeping. A programme
is normally mastered and encoded in one pass, so identical source audio
is encoded afresh in every episode: three real Planet Money episodes,
same encoder, same 128 kbit/s, same 44.1 kHz, had **nine matching frames
out of ninety thousand**. Two of them open with audio correlating at
r = 0.988 and share eighteen frames before diverging. Byte matching found
nothing, and no number of further episodes would have changed that.

So SelfPod decodes a low-rate mono copy — 5512 Hz, which is all the
fingerprint reads — and uses Haitsma–Kalker sub-fingerprints: the energy
in 33 logarithmic bands between 300 Hz and 2 kHz, emitted as one bit per
band pair for whether that pair's difference rose or fell since the
previous frame. Thirty-two bits every 11.6 ms.

The bit is the sign of a *difference of differences*, never an energy,
and that is what makes it work. Multiplying every band by the same factor
— which is what loudness normalisation does, and it is the first thing an
advert network applies — moves no sign at all. Re-encoding at a different
bitrate moves few. On the episodes above: 0.08 of bits wrong for the same
audio against 0.435 for different audio.

**What it costs.** A decoder in the image. It is an MP3 decoder and
nothing else, about eighty kilobytes of WebAssembly, in-process in a
sandbox rather than a subprocess, and LGPL-2.1 — recorded in
THIRD-PARTY-LICENSES.md with the image label saying so. That is a real
obligation and a small one; bundling ffmpeg would have been a real
obligation and a large one, along with a video-codec stack in an image
that is fed files chosen by strangers. Decoding runs at roughly a
thousand times real time and fingerprinting at two hundred, so an
hour-long episode is a few seconds on a desktop — once per episode,
behind a publish hold.

**What it does not give.** Frame-exact boundaries. Each sub-fingerprint
describes a 372 ms analysis window, so an edge is placed to a fraction of
a second rather than to the frame. The error is corrected for and then
deliberately biased outwards: a fraction of a second of programme lost at
the edge of an advert goes unnoticed, and a fraction of a second of
advert left behind is what somebody writes in about.

**Comparing two downloads of one episode** finds what a host stitches in
per request. It is the stronger signal, and the only one that identifies
an advert rather than something that merely repeats: a theme tune is in
both copies, so it cannot be what differs between them.

### 19.3 The cost of looking twice, and why it is rationed

A second download is a second IAB-countable listen, so it doubles the
publisher's figures for an episode taken once. Hosts also cache the
stitch per listener, keyed on requesting address and user agent, so two
requests from one container seconds apart are the same listener by
construction and would hit that cache. Defeating it would need a rotating
user agent or egress address; that is deliberate evasion of the
publisher's measurement and SelfPod will not do it.

So a second download happens only when the first file carries a positive
signal — a sample-rate or channel-mode change part-way through, or a Xing
header disagreeing with the frames present — never sooner than a day, a
couple per tick across all subscriptions, and charged to the same daily
byte budget. The second copy is deleted; the file on the share is the one
the owner has.

### 19.4 Cutting

Frames are removed and what remains is joined. The Xing header is
rewritten — its frame count, byte count and seek table, the last of which
otherwise maps percentages to offsets that no longer mean anything, which
is the fault reported as "the scrubber is broken". The episode's own ID3
tag survives untouched.

Two costs are inherent to cutting on frame boundaries and are stated
rather than hidden: the bit reservoir gives a soft artefact of about 26 ms
at each join, and encoder delay adds a few tens of milliseconds there too.
Both are identical under `ffmpeg -c copy`; avoiding either means
re-encoding, which spends the quality of the whole file to fix a
twentieth of a second. It is also why the trimmed duration is *measured*
from the result rather than computed as "original minus what was cut".

### 19.5 Publishing

An episode is held out of the feed until its trim is settled. The
alternative is to publish and swap the audio underneath, and this route
serves byte ranges: a client holding the first half of the untrimmed file
and asking for the rest would receive the second half of a shorter one and
stitch together an episode that never existed, silently.

The enclosure URL therefore carries a content version, and the trimmed
file on disk is named after that same version, so the row in the database
and the bytes it describes move together. A later re-cut is a different
URL rather than different bytes at the same one.

The version has to be **checked** on the way in, or it is decoration: a
route that resolves from the episode id alone serves whatever is current
whichever version was asked for, which is the hazard again with a longer
URL. The absence of a version is a claim in its own right — "the untrimmed
one" — which is what lets an episode that has never been cut keep the URL
it has always had, and still be refused once it has been. A refusal is the
right answer here: a download that fails is one the app retries.

A trim that fails publishes the original and says so loudly. An advert
that survives explains itself the moment it is heard; an episode that
silently never appears does not.

## 17. Acceptance checklist

Before considering this "done," verify each of these explicitly — every
one corresponds to a real failure from the manual prototype:

- [ ] Dropping an `.m4a` file into a show folder (no restart, no manual
      trigger) results in it appearing in the feed within the configured
      rescan interval, with correct `type="audio/x-m4a"`.
- [ ] A filename containing spaces, an emoji, and a curly quote produces
      a feed whose `<enclosure url>` is valid and downloadable via
      `curl` without modification.
- [ ] A cover image saved as `cover.png` (not `.jpg`) is detected and
      served correctly.
- [ ] Renaming an episode file on disk updates its filename in the feed
      but **does not** change its `<guid>`.
- [ ] Running the container with a `PUID` that does not have read access
      to `/data/shows` results in a clear, specific error in both the
      container logs and the web UI — not a silent 403 discovered only
      by a podcast app.
- [ ] Editing a show's title, then triggering a rescan, does not revert
      the title back to a filename-derived default.
- [ ] Updating `cover.jpg` is visible via `curl -I` on the media URL
      within a few seconds (short cache), without needing to restart
      anything.
- [ ] Removing an episode's file from disk does not immediately drop it
      from the feed (soft "missing" state), and does drop it after the
      configured grace period.
- [ ] The entire setup, from `docker run` to a working feed with two
      shows, requires editing `docker-compose.yml` (or the `docker run`
      command) exactly once — never again when adding a third show.
- [ ] A show with advert removal set to "show me what repeats" holds its
      new episodes out of the feed, and the show page says how many are
      waiting and why — not just that something is pending.
- [ ] Approving a repeated segment publishes the episodes with that audio
      gone, at a shorter `length`, a shorter `itunes:duration`, and an
      enclosure URL that differs from the one served before the cut.
- [ ] The audio either side of a cut downloads byte-identical to the
      original, and a `Range` request for the second half of a trimmed
      episode returns exactly the second half of what a whole-file `GET`
      returns.
- [ ] Rejecting a segment that was previously approved puts the audio
      back, and the episode is served whole again.
- [ ] Turning advert removal off for a show releases every episode it was
      holding, in the same request — not on the next scheduled scan.
