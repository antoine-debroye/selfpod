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
- **Counts downloads and plays, per episode and per show.** Whole-file downloads
  and partial streams are counted separately, alongside a request-by-request log
  naming the app that asked (“Pocket Casts”, “Apple Podcasts”). Failed requests
  are shown first, so an episode that will not download in someone's podcast app
  is visible here instead of only on their phone. No IP addresses are stored, and
  your own visits to the admin interface are never counted.
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
   feed URL the show page gives you — see
   [Subscribing from a podcast app](#subscribing-from-a-podcast-app).

Or use [`docker-compose.yml`](docker-compose.yml) from this repo, which is the
same thing in file form.

---

## Installing on TrueNAS SCALE (24.10 "Electric Eel" and newer)

TrueNAS 24.10 dropped Kubernetes for Docker, so SelfPod installs as a Custom App.

### 1. Decide where your audio lives

Either make a dataset for it (**Datasets → Add Dataset**, using the **SMB** or
**Multiprotocol** preset if you also want to copy files in over SMB), or point
SelfPod at a folder you already have — see *Reusing an existing media folder*
below.

SelfPod also needs a small dataset of its own for its database. Add one called
`selfpod`, then open **Permissions → Edit** on it and set the owner to the same
user that owns your audio. A new dataset belongs to `root`, and SelfPod does not
run as root, so skipping this step is the most likely way to end up with an app
that starts and then cannot write anything.

### 2. Find the UID and GID that own your files

This is the single most important step, and skipping it causes almost every
permission problem people hit with self-hosted media apps.

Open **System → Shell** and run:

```bash
id your-username
```

You will get something like `uid=3000(antoine) gid=3001(antoine)`. Use those for
`PUID` and `PGID` respectively.

> **Read both numbers.** They are often different, and they do not have to match.
> On a real box the user was `3000` while their group was `3001` — and `3000`
> happened to be a *different* group (`SMB_Users`), so assuming "GID = UID" would
> have silently granted the wrong group. Check the **Credentials → Groups** page if
> you want to confirm the group's number.

> **Why not just use 568?** `568` is TrueNAS's built-in `apps` user, and plenty of
> guides suggest it. It only works if your dataset's ACL actually grants that user
> access. If you copy files in over SMB as yourself, your own UID is the right
> answer, and SelfPod will read exactly what you wrote.

### 3. Install the app

**Apps → Discover Apps → Custom App.** That opens a form rather than a YAML box on
current TrueNAS versions, so fill it in as follows and leave everything else alone:

| Section | Field | Value |
|---|---|---|
| Application name | Application Name | `selfpod` |
| Image | Repository | `ghcr.io/antoine-debroye/selfpod` |
| Image | Tag | `latest` |
| General | Timezone | your zone, e.g. `Europe/London` |
| Container | Environment Variable | `PUBLIC_BASE_URL` = the address you will reach SelfPod on |
| Container | Environment Variable | `PUID` = your UID |
| Container | Environment Variable | `PGID` = your GID |
| Container | Restart Policy | **Unless Stopped** — the default is *No*, which will not survive a reboot |
| Network | Port: Host `8080`, Container `8080` | |
| Storage | Host Path `/mnt/your-pool/selfpod` → Mount Path `/data` | |
| Storage | Host Path `/mnt/your-pool/.../your-audio` → Mount Path `/data/shows` | |

Leave it a moment: TrueNAS shows the app as *Deploying* until the health check
passes, which takes up to about 30 seconds on first start.

#### Reusing an existing media folder

The two storage rows above are what let you point SelfPod at audio you already
have. Mount your existing folder at `/data/shows` and each subfolder in it becomes
a show — no files are moved and nothing is renamed. SelfPod's database stays in the
separate `selfpod` dataset, so it never appears in your media share.

The one visible change: SelfPod writes a `show.json` into a show's folder after you
first edit that show's settings, so your metadata is portable. Nothing is written
until you make an edit.

### 4. Get the first-run password

**Apps → selfpod → the log icon** next to the container, or in the shell:

```bash
docker logs selfpod
```

Look for the boxed banner containing the generated password. Sign in with it and
the setup wizard will ask you to choose your own.

The log view only streams from the moment you open it, so if the banner has already
scrolled past, use the reset described in **Locked out?** below rather than hunting
for it.

### Notes for TrueNAS specifically

- **Port already in use?** Change the left-hand number in `"8080:8080"`. The
  TrueNAS UI itself uses 80 and 443; check **Apps** for anything else on 8080.
- **Updating.** TrueNAS does not reliably detect a new `:latest` for a Custom App.
  To update, **Edit** the app and save (which re-pulls), or in the shell:
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

## Subscribing from a podcast app

Every SelfPod feed is **private and unlisted**, and that changes how you add it.

Some apps treat a subscribe link as a *lookup in their own public directory* rather
than a feed to fetch. Your feed is in no directory, so those apps open and say
something like "unable to find podcast, please contact the podcast author" — even
though the very same URL pasted into their search box works immediately. **Pocket
Casts behaves this way**, and its own documentation says an unlisted feed should be
added by pasting the URL into the app's search bar.

So the show page offers two different things, per app:

- **Apple Podcasts, Overcast, Castro** — a QR code carrying that app's subscribe
  scheme. Scan it with your phone's camera and the app opens and subscribes.
- **Pocket Casts, and any other app** — the instruction that works: copy the feed
  URL and paste it into the app's search or "add by URL" box. No QR, because there
  is nothing useful to encode.

Do not put the plain `https://` feed URL in a QR code and expect it to subscribe:
a phone camera hands it to the browser, which shows the raw XML with no way onward
to a podcast app.

If an app that should work says it can't find the podcast, paste the URL in instead.
That path depends on nothing but the app being able to fetch a URL.

## Statistics, and what they honestly mean

**Statistics** in the sidebar records every request a podcast app makes, and shows
it three ways: totals for the instance, a row per show, and a per-episode count in
each show's episode table. Each episode's own page carries its numbers and its own
request log.

Two figures are counted separately, because merging them makes both meaningless:

- a **download** is a request for the whole file — an app fetching an episode for
  offline listening;
- a **stream** is a range request — a player starting playback without downloading
  first, or seeking. One listener scrubbing through an episode generates many.

Neither is a *listen*. No podcast server can know whether a downloaded episode was
ever played, and SelfPod does not pretend to. Take the download figure as "how many
apps asked for this", nothing more.

**Failures are the useful half.** A request SelfPod could not serve is recorded with
its status code and a plain-language reason — `Permission denied reading … as UID
3000`, or `episode.m4a is not on disk` — and surfaced at the top of the page. This
is the situation that used to be invisible: the file looked fine in the admin UI and
failed only in someone's podcast app.

What is deliberately **not** recorded: no IP addresses, no raw user agents (only a
coarse app family), and never the feed token, which appears in every one of these
URLs and is a credential. Requests you make yourself while signed in — including
previewing an episode in the editor — are excluded, so the numbers stay yours. The
log keeps a year of history and trims itself daily.

## Locked out?

SelfPod prints its generated password once, to the container log. If that has
scrolled away, reset it from inside the container:

```bash
docker exec selfpod node scripts/reset-password.js
```

On TrueNAS, use **Apps → selfpod → the shell icon** next to the container and run
`node scripts/reset-password.js` there.

A new temporary password is printed, everyone is signed out, and the next sign-in
asks you to choose your own. Nothing else is touched — your shows, episode
identities and feed tokens are unchanged, so subscribers are unaffected.

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
