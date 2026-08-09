# SelfPod

**Drop a file in a folder. It's an episode.**

SelfPod turns folders of audio files into private podcast feeds you can subscribe
to in any podcast app. One container, one volume, no configuration per show.

```
/data/shows/late-night-tape-club/     ← this folder is a show
  ├── cover.jpg
  ├── 2026-08-07-episode-42.m4a       ← this file is an episode
  └── 2026-08-08-episode-43.mp3
```

That is the whole workflow. Copy a file in over SMB, NFS, `docker cp`, or the
browser, and it appears in your feed within seconds — no restart, no cron job, no
regenerate button.

---

## What it does

- **Auto-discovers shows and episodes.** A new folder is a new show. A new audio
  file is a new episode. Adding your tenth show takes exactly as much
  configuration as your first: none.
- **Serves real podcast feeds.** RSS 2.0 with the iTunes and Podcasting 2.0
  namespaces, stable episode GUIDs, correct MIME types, and HTTP Range support so
  scrubbing and download-resume work properly.
- **Handles every common format**: `mp3`, `m4a`, `aac`, `ogg`, `opus`, `wav`,
  `flac`. Nothing is converted; files are served exactly as you left them.
- **Keeps your feeds private.** Each show has its own unguessable token in its
  URL, rotatable if it ever leaks. No account needed in the podcast app.
- **Tells you when something is wrong.** Every scan is logged in plain language —
  a permission problem names the exact path and the UID SelfPod runs as. You
  should never have to read container logs over SSH to find out why an episode
  didn't appear.
- **Moves house easily.** Everything — database, settings, media, artwork — lives
  in one directory. Copying it to another machine moves your whole instance.

## What it deliberately does not do

- No transcoding or loudness normalisation. Files are served as you uploaded them.
- No multi-user support. One admin account per instance.
- No TLS. SelfPod speaks plain HTTP and expects your own reverse proxy or tunnel
  (Cloudflare Tunnel, Caddy, Traefik, nginx) in front of it, like any other
  self-hosted service.

---

## Quick start

```bash
docker run -d --name selfpod \
  -p 8080:8080 \
  -v /path/on/host/selfpod-data:/data \
  -e PUBLIC_BASE_URL=https://podcast.example.com \
  -e PUID=1000 -e PGID=1000 \
  -e TZ=Europe/London \
  --restart unless-stopped \
  ghcr.io/antoine-debroye/selfpod:latest
```

Then:

1. `docker logs selfpod` — on first run SelfPod generates an admin password and
   prints it once.
2. Open the app, sign in, and pick your own password in the three-step setup.
3. Make a folder under `/data/shows/`, drop audio into it, and subscribe to the
   feed URL the show page gives you (there is a QR code for your phone).

Or use [`docker-compose.yml`](docker-compose.yml) from this repo, which is the
same thing in file form.

---

## Installing on TrueNAS SCALE (24.10 "Electric Eel" and newer)

TrueNAS 24.10 dropped Kubernetes for Docker, so SelfPod installs as a Custom App.

### 1. Make a dataset for your podcasts

**Datasets → Add Dataset.** Name it something like `podcasts`. If you also want
to copy files in over SMB, use the **SMB** or **Multiprotocol** dataset preset —
that gets the ACLs right for mixed access.

### 2. Find the UID and GID that own your files

This is the single most important step, and skipping it causes almost every
permission problem people hit with self-hosted media apps.

Open **System → Shell** and run:

```bash
id your-username
```

You'll see something like `uid=3001(antoine) gid=3001(antoine)`. Those two
numbers are your `PUID` and `PGID`. Use the account that owns — or will own — the
audio files, typically the same account you use for the SMB share.

> **Why not just use 568?** `568` is TrueNAS's built-in `apps` user, and plenty of
> guides suggest it. It only works if your dataset's ACL actually grants that user
> access. If you're copying files in over SMB as yourself, your own UID is the
> right answer, and SelfPod will read exactly what you wrote.

While you're in the dataset's **Edit ACL** screen, make sure your user has
**Full Control** with **inheritance enabled**, so files created later are also
readable. SelfPod never changes permissions on your files — it reports problems
and leaves your library alone.

### 3. Install the app

**Apps → Discover Apps → ⋮ (top right) → Install via YAML.** Paste this, editing
the three marked values:

```yaml
services:
  selfpod:
    image: ghcr.io/antoine-debroye/selfpod:latest
    container_name: selfpod
    restart: unless-stopped
    environment:
      PUBLIC_BASE_URL: https://podcast.example.com   # ← your public address
      PUID: 3001                                      # ← from `id your-username`
      PGID: 3001                                      # ← from `id your-username`
      TZ: Europe/London
    volumes:
      - /mnt/your-pool/podcasts:/data                 # ← your dataset path
    ports:
      - "8080:8080"
    init: true
```

Leave it a moment: TrueNAS shows the app as *Deploying* until the health check
passes, which takes up to about 30 seconds on first start.

### 4. Get the first-run password

**Apps → selfpod → Logs**, or in the shell:

```bash
docker logs selfpod
```

Look for the boxed banner containing the generated password. Sign in with it and
the setup wizard will ask you to choose your own.

### Notes for TrueNAS specifically

- **Port already in use?** Change the left-hand number in `"8080:8080"`. The
  TrueNAS UI itself uses 80 and 443; check **Apps** for anything else on 8080.
- **Updating.** TrueNAS does not reliably detect a new `:latest` for custom-YAML
  apps. To update, **Edit** the app and save (which re-pulls), or in the shell:
  `docker pull ghcr.io/antoine-debroye/selfpod:latest` and restart the app.
- **Keep `/data` on your pool**, as above. Don't point it at an NFS or SMB *mount* —
  SQLite can't lock reliably over those, and SelfPod will warn you if it detects it.

---

## Other platforms

<details>
<summary><strong>ZimaOS</strong></summary>

ZimaOS installs Docker Compose apps directly. **Apps → Custom Install → Import**,
then paste the compose file above with your own paths. ZimaOS usually runs
containers as UID 1000, which matches SelfPod's default, so `PUID`/`PGID` can
often be left alone.
</details>

<details>
<summary><strong>Unraid</strong></summary>

**Docker → Add Container**, then set: repository
`ghcr.io/antoine-debroye/selfpod:latest`, port `8080`, path `/data` → your share
(e.g. `/mnt/user/podcasts`), and `PUID`/`PGID` to `99`/`100` — Unraid's usual
`nobody`/`users` pair.
</details>

<details>
<summary><strong>Synology</strong></summary>

Container Manager → Project → Create, and paste the compose file. Find your
`PUID`/`PGID` by SSHing in and running `id your-username` (Synology's first user
is typically `1026`).
</details>

---

## Putting it on the internet

SelfPod serves plain HTTP on port 8080 and expects something in front of it.

<details>
<summary><strong>Cloudflare Tunnel</strong></summary>

Point a public hostname at `http://selfpod:8080` (or your host's IP and port),
and set `PUBLIC_BASE_URL` to that hostname. Three Cloudflare-specific things are
worth knowing:

- **Uploads over 100 MB fail on the free plan.** Cloudflare rejects large request
  bodies at the edge, before they reach SelfPod, whatever `MAX_UPLOAD_SIZE_MB`
  says. For big episodes, copy them into the show folder directly, or use
  SelfPod's local address on your LAN. SelfPod detects this case and says so
  rather than leaving you with an unexplained failure.
- **Exempt the hostname from Bot Fight Mode** and managed challenges. Podcast
  apps fetching your feed cannot solve a challenge, and your subscribers would
  silently stop receiving episodes.
- **Use a named tunnel**, not a `trycloudflare.com` quick tunnel — quick tunnels
  buffer streaming responses, which breaks the live scan progress display.

Also note that Cloudflare's own logs will contain your full feed URLs, tokens
included.
</details>

<details>
<summary><strong>Caddy</strong></summary>

```caddyfile
podcast.example.com {
    reverse_proxy selfpod:8080
}
```

That's all — Caddy handles the certificate, and SelfPod reads
`X-Forwarded-Proto` so its session cookies are marked `Secure` automatically.
</details>

---

## Configuration

Only `PUBLIC_BASE_URL` matters; everything else has a sensible default, and most
of it can be changed later in **Settings** without touching the container.

| Variable | Default | What it does |
|---|---|---|
| `PUBLIC_BASE_URL` | — | The address your proxy serves SelfPod on, e.g. `https://podcast.example.com`. Every feed and media URL is built from it. No trailing slash. Can also be set in the setup wizard. |
| `PUID` / `PGID` | `1000` | The user and group SelfPod runs as. Match the owner of your audio files. |
| `TZ` | `UTC` | Used for displayed dates and an episode's default publish date. |
| `PORT` | `8080` | Port inside the container. |
| `RESCAN_INTERVAL_SECONDS` | `300` | How often the whole library is re-checked as a fallback. 60–21600. |
| `MISSING_GRACE_SECONDS` | `86400` | How long an episode whose file vanished stays in the feed, so a brief share outage doesn't drop episodes. |
| `MAX_UPLOAD_SIZE_MB` | `1024` | Cap for browser uploads. A proxy in front may impose a lower one. |
| `ADMIN_USERNAME` | `admin` | First-run only. |
| `ADMIN_PASSWORD` | — | First-run only. If unset, a random password is generated and printed once to the logs. |
| `SESSION_SECRET` | generated | First-run only; afterwards it lives in the database. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. |

---

## How it finds new episodes

Two mechanisms, on purpose.

A **filesystem watcher** notices changes within seconds — that's the fast path.
But `/data` is often a network share, and writes made on another machine
frequently deliver no filesystem events at all, with no error to see: the episode
simply never appears. So a **periodic rescan** (every 5 minutes by default) is
what actually guarantees correctness.

If SelfPod notices the watcher isn't reporting changes that the periodic scan
keeps finding, it switches itself to polling and says so in the UI. That message
is not a fault — it's normal for SMB and NFS shares, and everything keeps working.

## Moving to a new machine

Everything stateful is inside the one volume, including the database, your admin
password, feed tokens and episode identities.

```bash
docker compose down                     # or stop the app in your NAS UI
rsync -a /path/on/host/selfpod-data/ new-machine:/path/on/new/selfpod-data/
# start SelfPod on the new machine with the same PUBLIC_BASE_URL
```

Existing subscribers keep working, because the feed URLs and episode GUIDs move
with the data. If the new machine's file ownership differs, adjust `PUID`/`PGID`
to match.

---

## Development

```bash
npm install
npm test                       # 125 unit and integration tests
npm run dev                    # http://localhost:8080, data in ./.devdata

docker build -t selfpod:test .
./test/acceptance/run.sh       # 18 end-to-end checks against a real container
```

The acceptance script checks the behaviours that matter most: an `.m4a` appearing
with no restart, a filename containing an emoji and curly quotes surviving into a
downloadable URL, `cover.png` being found, a rename keeping its GUID, an edited
title surviving a rescan, the missing-file grace period, and a wrong `PUID`
producing an explanation in both the logs and the browser.

**Layout.** `src/services/` holds the engine (scanner, feed builder, watcher,
scheduler); `src/routes/` the JSON API and the public token-gated feed and media
routes; `src/web/` the server-rendered admin UI (Eta templates plus htmx, no build
step). The design system lives in `src/web/public/css/app.css`.

## Licence

MIT — see [LICENSE](LICENSE).
