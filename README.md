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
| `MAX_DOWNLOAD_SIZE_MB` | same as upload cap | Largest episode SelfPod will fetch from a followed feed. |
| `SUBSCRIPTIONS_ENABLED` | off | Lets SelfPod follow remote feeds. Off by default: it is the only thing that makes SelfPod fetch from the internet. Seeds the setting on first run; after that the Settings page wins. |
| `REMOTE_POLL_INTERVAL_SECONDS` | `3600` | How often to check a followed feed. Clamped to 15 minutes – 24 hours — this is someone else's server. |
| `ALLOW_PRIVATE_FEED_HOSTS` | *(empty)* | Comma-separated **IP addresses** that may be followed despite being private, e.g. a feed on your own NAS. Exempts only the addresses listed, and only from the address and port rules. Env-only on purpose: it weakens a guarantee, so changing it should mean touching the container. |
| `ADMIN_USERNAME` | `admin` | First-run only. |
| `ADMIN_PASSWORD` | — | First-run only. If unset, a random password is generated and printed once to the logs. |
| `SESSION_SECRET` | generated | First-run only; afterwards it lives in the database. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. |
| `WHISPER_MODEL` | `base` | Which speech model hears the words: `base` or `small` (both ship in the image), or a path to a whisper.cpp model file. `small` is about twice the work and markedly better in French. |
| `WHISPER_CLI` | *(the image's own)* | Path to a `whisper-cli` binary, for a build of your own. The image picks its AVX2 or SSE4.2 build for the CPU at boot. |
| `WHISPER_THREADS` | `2` | Threads the recogniser may use. Two is right for a box that is also serving audio. |

---

## Cutting the adverts out

SelfPod can find sponsor reads and other repeated audio in a show's episodes and
remove them from every one of them. Set it per show, under **Adverts** on the show's
page.

| Setting | What happens |
|---|---|
| **Nothing** *(default)* | Your episodes are published exactly as they arrive. SelfPod never listens to them or reads them. |
| **Listen, tell me what it heard, and wait** | New episodes are held out of your feed until you have decided about anything that sounds like a sponsor read or repeats across episodes. Remove a read once and the same words are cut from later episodes without asking. |
| **Remove what it is sure about, without asking** | SelfPod cuts a stretch when the words say sponsor read and the same words come back in other episodes, or when you have removed that read before. Anything it is unsure of is listed for you and the episode is published untouched. |

**It reads the words.** SelfPod transcribes the opening and closing minutes of each
MP3 episode — on your own machine, with [whisper.cpp](https://github.com/ggml-org/whisper.cpp);
nothing leaves it — and looks for three things in the text:

- **The same words, day after day.** A campaign runs for a week, and the host reads
  the same script every morning. The audio is different every time, so nothing that
  compares sound can find it; the words are the same, and SelfPod finds those, allowing
  for the recogniser's mishearings.
- **Wording that sounds like an advert.** "Brought to you by", a promo code, a web
  address, "terms apply" — and in French, "sans engagement", "code promo", "soumise à
  condition", the small print the law makes advertisers say. Every candidate shows
  which of these it heard.
- **A boundary you point at.** On any episode page, pick the words the programme
  starts with — "Vous écoutez RMC" — and press *The programme starts here*. From then
  on everything before those words is cut in every episode where SelfPod hears them,
  whatever it is. That is how a pre-roll that is a different advert every day goes.

**It shows you the words.** Each candidate is the transcript with the cut marked and a
few seconds either side, the cues that fired, and one sentence saying what SelfPod will
do and why — "This sounds like a sponsor read: it says ‘brought to you by’ and gives a
web address, but you asked to decide first." Tap a word to move an edge. The player
carries three seconds either side, so the edges can be judged by ear.

**It remembers.** Remove a read once and later episodes carrying the same words are cut
without asking, in review mode too — that decision was yours. Keep one and it is never
offered again. Every automatic cut says why, wherever it is mentioned, and every one
can be put back with one click.

**It still compares what episodes sound like.** The acoustic detector from 1.6 — 32
bits every 11.6 milliseconds describing how energy moves between frequency bands,
which survives re-encoding and loudness changes — runs as before and finds the theme
tune, the bed under the credits and a pre-recorded read. When the words of such a
stretch turn out to say sponsor, the theme-tune guard that used to hold it lets go.

**Where to listen** is per show: the first five and last four minutes by default,
or the whole episode to catch mid-roll reads at the cost of as much work as the
episode is long. Reading speech is the expensive part: a small NAS runs the default
`base` model at a few times real time, so the opening and closing of an episode is a
minute or two of work behind the publish hold; a desktop is many times faster. The
page quotes the measured speed once it has heard something. `WHISPER_MODEL=small`
selects the larger model that ships alongside — roughly twice the work, and markedly
better in French.

**Your files are never touched.** The trimmed copy lives with SelfPod's other
derived data and can be deleted at any time; the originals in your show folders are
exactly as you left them. Change your mind about a segment and the episodes go back
to how they were.

**Nothing is decoded or re-encoded** on the way to your subscribers: what they download
is byte-identical to your original everywhere except the few milliseconds either side
of a join. Cutting an hour-long episode takes about a thirtieth of a second.

**Episodes are held until the decision is settled**, rather than published and then
swapped. Podcast apps download in pieces and resume, so replacing an episode's audio
underneath a URL a listener is part-way through would hand them half of one file and
half of another with nothing to notice. Held episodes are counted and explained on
the show's page — a feed that quietly stops is the thing this app exists to prevent.
An episode is never held for a recogniser that is not there: if whisper cannot run on
your machine, the health banner says so and everything is published as it arrives.

### Adverts a host inserts as it serves

Some podcasts insert adverts into the audio as it is downloaded, so the file is
different every time. SelfPod can spot these by downloading one episode a second
time, a day later, and comparing: whatever changed cannot be the theme tune, so it
is an advert by construction.

This is done sparingly and on purpose. A second download counts again in the
publisher's listener figures, so SelfPod only does it for episodes whose audio shows
positive signs of having been stitched together, never sooner than a day, and only a
couple at a time. It will not disguise itself to defeat a host's caching — that
would be interfering with the publisher's measurement, which is not SelfPod's to do.

Only for `.mp3` at present. Other formats are published untouched.

---

## When the feed no longer matches the folder

**Rescan** (top of a show page) re-reads every file and re-hashes it, so it catches
audio you replaced even when the name, size and modification time all look unchanged.
This is the one to reach for, and it costs subscribers nothing.

What a rescan deliberately will *not* do is undo your own decisions. It never
overwrites a title, date or description you edited here; it never brings back an
episode you removed from the feed; and a description taken from a file's tags is read
only when SelfPod first sees that file. Those are the right defaults — but together
they mean a library that has been renamed, re-tagged and re-encoded outside SelfPod can
end up with a feed that no longer resembles the folder.

**Rebuild from disk** (Danger zone, on the show page) is the way back. SelfPod forgets
every episode of that show and reads the folder again from scratch: titles, dates and
descriptions come from the files and their tags, and any audio still in the folder is
back in the feed. **No audio file is touched.**

It is confirmed twice — tick the acknowledgement *and* type the folder name — because
the cost lands on your listeners rather than on you: episodes get new identities, so
podcast apps treat the whole back catalogue as new, download it again, and lose what
was marked played. Try Rescan first.

## How it finds new episodes

Two mechanisms, on purpose.

A **filesystem watcher** notices changes within seconds — that's the fast path.
But `/data` is often a network share, and writes made on another machine
frequently deliver no filesystem events at all, with no error to see: the episode
simply never appears. So a **periodic rescan** (every 5 minutes by default) is
what actually guarantees correctness.

If SelfPod notices the watcher isn't reporting changes that the periodic scan keeps
finding, it switches itself to polling. That is normal for SMB and NFS shares and
everything keeps working, so it is reported as information rather than as a fault: the
dashboard mentions it once, dismissibly, and **Settings → Live file detection** always
shows the current mode. It deliberately does not sit in a banner across every page —
a banner that is always there is a banner nobody reads when something is actually
wrong.

## Security

SelfPod is built to be published to the internet, so the design assumes the address
is known and the login page is being probed.

**What is reachable without signing in.** Only four things: `/health`, a show's RSS
feed, its cover art, and its episode audio. The last three require that show's
22-character token (≈131 bits, compared in constant time). A wrong token and a
show that does not exist return byte-identical 404s, so feeds cannot be found by
guessing slugs, and nothing anywhere returns 403 — which would confirm a hit.
Everything else redirects to the login page or answers 401.

**Files it will serve.** Only files that genuinely live inside a show's own folder.
Filenames from the database are validated, and the resolved real path is checked to
be inside that folder — so a symlink dropped into your media share cannot be used to
publish something else from the host. The URL's filename segment is decorative:
episodes are looked up by id, so nothing you put there changes which file is read.
The audio directory is registered with `serve: false`, meaning there is no open
static root over your media at all.

**Getting from SelfPod onto your network.** With feed subscriptions switched off —
which is the default — SelfPod makes exactly one kind of outbound request: the
optional public-address self-test, which fetches the address in Settings and nothing
else. It takes no URL from the request, it is rate limited, and it returns nothing
from the response body unless the reply cryptographically proves it came from this
same instance.

Turning on **Follow a feed** grants SelfPod the ability to fetch an address you give
it, which is a real change and is why it is opt-in. It is held to four rules:

- only a signed-in admin, on a same-origin request, can supply a URL at all;
- the address is refused unless it is http or https, on port 80 or 443, with no
  credentials in it, and **every** address it resolves to is public — private ranges,
  loopback, link-local, carrier-grade NAT and the cloud metadata address are all
  refused, including when written in an obscure form or hidden inside an IPv6 address;
- the connection goes to the address that was checked, and the whole check runs again
  at **every redirect hop and every poll** — never once, when you save it, and then
  trusted afterwards;
- what comes back reaches you as a fixed list of fields — feed title, episode titles,
  dates, durations, and the host of each audio file. Never a response body, never a
  header, never a redirect target, and never *why* a fetch failed, because telling
  "refused" apart from "timed out" is enough to map a network.

No unauthenticated request causes any outbound traffic, with or without the feature
on. There is no shell execution, no `eval`, and no dynamic code loading anywhere in
the app.

**Reading the audio.** Removing adverts means SelfPod parses episode files, and a
file downloaded from a followed feed is written by someone you do not control. That
parsing is deliberately as small as it could be. Cutting walks MP3 frame headers and
never decodes. Comparing sound decodes MP3 and nothing else, through an eighty-kilobyte
WebAssembly decoder running in-process inside the Wasm sandbox. Hearing the words
runs whisper.cpp as a child process — two megabytes of MIT-licensed code, no shell,
low priority, a hard time limit — fed a WAV that SelfPod's own decoder wrote a moment
earlier, never a file chosen by a stranger; an illegal instruction or a bad allocation
in it ends the child, not the server. SelfPod ships no `ffmpeg`, which is a decision
rather than an omission, since bundling one would put a full video-codec stack inside
an image that is handed files chosen by strangers. The reader is bounded on frame
count and refuses a file it cannot make sense of rather than hunting through it.

If you have a feed on your own LAN that you genuinely want followed, name its address
in `ALLOW_PRIVATE_FEED_HOSTS`. It exempts exactly the addresses you list — not their
neighbours, not their range — and leaves every other rule above in force.

**If a browser bug ever did get through.** Responses carry
`Content-Security-Policy: script-src 'self'` with no `unsafe-inline` — every script in
SelfPod is a file under `/assets`, so injected markup cannot execute — plus
`frame-ancestors 'none'`, `nosniff`, `X-Frame-Options: DENY` and
`Referrer-Policy: no-referrer` (the feed token is printed on the show page, and this
guarantees no navigation carries the URL off-site). Changing the password always
requires the current one, so a stolen session cannot lock you out of your own
instance.

**Passwords.** bcrypt, with per-account exponential backoff keyed so that forging
`X-Forwarded-For` buys nothing. Sessions live in SQLite and are invalidated
server-side on logout.

**Container.** Runs as the UID you choose, never root unless you ask. With the
`cap_drop`/`security_opt` block in [`docker-compose.yml`](docker-compose.yml) the app
process holds no capabilities at all, `NET_RAW` included, and no setuid binary can be
used to climb back to root.

### Taking SelfPod off your network entirely

If you only ever reach SelfPod through a tunnel, it does not need to be on your
network at all. [`docker-compose.tunnel.yml`](docker-compose.tunnel.yml) runs SelfPod
and `cloudflared` in one stack with **no published port**, and points the tunnel at
`http://selfpod:8080` — the stack's own private network name.

Measured with exactly that arrangement:

| Connecting from | Result |
| --- | --- |
| `cloudflared`, in the same stack | works — HTTP 200 |
| Another container, by name | refused |
| Another container, by the private address | refused (Docker isolates the networks) |
| Anywhere on your LAN | no socket exists to connect to |

This is stronger than the usual advice of binding the port to `127.0.0.1`, for two
reasons. A loopback-bound port is still open to everything else running on the NAS.
And more practically, `cloudflared` in its own container **cannot reach the host's
loopback** — so "just bind it to localhost" silently breaks the tunnel, which is the
first thing you discover after doing it.

The trade-off is that there is no local fallback: if the tunnel is down, so is your
admin access, until you add a `ports:` entry back and redeploy. Decide that before you
need it, not after.

### Or: restricting the published port to your own subnet

If you want to keep the port but only allow your own network, filter it in Docker's
`DOCKER-USER` chain — **not** the usual `INPUT` chain, which never sees published
container ports because Docker's rules run in `FORWARD` after address translation.

Two things make a naive rule wrong. Matching `--dport` catches the *container* port
(8080) and would hit every other container using it, so match the original port with
conntrack instead. And a reverse proxy running in another container reaches SelfPod
from a **Docker address**, not a LAN one — so allowing only your subnet silently kills
your own tunnel. Both are handled here (replace `31080` and the subnet with yours):

```bash
iptables -I DOCKER-USER 1 -p tcp -m conntrack --ctorigdstport 31080 -s 192.168.10.0/24 -j RETURN
iptables -I DOCKER-USER 2 -p tcp -m conntrack --ctorigdstport 31080 -s 172.16.0.0/12 -j RETURN
iptables -I DOCKER-USER 3 -p tcp -m conntrack --ctorigdstport 31080 -j DROP
```

Check it before trusting it: the app should still load from a machine on your subnet,
the public hostname should still work (that proves the proxy rule is right), and a
host on another VLAN should time out. To undo, swap `-I` for `-D` and run the three
again — or reboot, since these are not persistent. On TrueNAS, make them persistent
with **System Settings → Advanced → Init/Shutdown Scripts**, as a *Post Init* command.

Worth being clear about what this buys: if your network is flat, the port was already
only reachable from that subnet and this changes nothing. It helps when other networks
— a guest VLAN, IoT devices, VPN clients — can route to the NAS.

### Two things SelfPod cannot fix for you

**Plain HTTP on your LAN.** SelfPod speaks HTTP and expects your proxy to terminate
TLS. If you reach the admin UI over a LAN address, your session cookie crosses your
network in the clear, and anything on that network can read it — a compromised smart
TV included. Either take it off the LAN as above, or put TLS in front of the LAN
address too.

**Egress.** Dropping capabilities stops raw packets; it does not stop ordinary TCP
connections. A container that is compromised some other way can still try to reach
other hosts on your network, because Docker's default bridge allows it. Capabilities
are the wrong tool for that — the right one is a network policy that denies egress
except to what SelfPod needs (which is nothing, unless you use the self-test). Worth
doing if the NAS shares a network with things you care about.

## Testing your public address

The hostname in the top bar is a button. Clicking it tests that address twice: once
from your browser, and once from SelfPod itself. Two vantage points, because one
cannot tell these apart:

- **reachable** — both got through, and the reply proved it came from this container.
- **blocked here** (amber) — SelfPod reached the address but your browser would not
  make the call. An extension, a strict privacy mode, or a rule against calling an
  `https` address from a plain-`http` page. **Your listeners are unaffected**; this
  says nothing about your setup.
- **wrong server** — the address answers, but not from this container. An old copy
  still running, or a proxy sending that hostname elsewhere. This is the one worth
  chasing: everything looks healthy while subscribers get someone else's feeds.
- **unreachable** — neither could reach it, with the underlying reason named (DNS
  does not resolve, connection refused, certificate rejected, timed out).

That last detail comes from SelfPod's own attempt. A browser deliberately hides why
a request failed, so the browser alone can only ever say "something went wrong" —
which is why this test used to blame DNS for problems that were nothing of the sort.

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
npm test                       # 469 unit, integration and security tests
npm run dev                    # http://localhost:8080, data in ./.devdata

docker build -t selfpod:test .
./test/acceptance/run.sh       # 32 end-to-end checks against a real container
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

## Changes

[CHANGELOG.md](CHANGELOG.md) — what each release changed, and which ones your listeners
would notice.

## Licence

MIT — see [LICENSE](LICENSE).
