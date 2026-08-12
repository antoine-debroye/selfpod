# Changelog

Notable changes to SelfPod. Versions follow [semantic versioning](https://semver.org),
and images are published to `ghcr.io/antoine-debroye/selfpod` under the matching tag.

Updating is changing the image tag and redeploying. The database migrates itself
forward on start, and no release so far has needed anything else — where a release
changes what your listeners see, it says so.

## 1.5.0 — 2026-08-12

### Fixed

- **A podcast app checking your feed correctly was invisible.** When nothing had
  changed, SelfPod answered "you already have it" and returned before recording the
  request — so an app polling every fifteen minutes never appeared in the feed-check
  count, and a show could report "last checked three days ago" while an app was doing
  everything right. That figure exists to answer *why hasn't my app picked up the new
  episode?*, and it was answering it wrongly. Artwork requests had the same fault.

  **This changes your numbers.** Feed checks will jump by one to two orders of
  magnitude, older rows are not backfilled, so any period spanning this upgrade mixes
  two counting rules. No bandwidth figure moves — feed traffic has never counted as
  audio served and still does not. The access log grows accordingly: one subscriber
  polling one show every fifteen minutes is about 96 rows a day, kept for a year.

- **Behind Cloudflare, no feed check ever succeeded.** SelfPod compared the caller's
  validator to its own as an exact string, and Cloudflare — which the README
  recommends — re-labels those validators in transit. The comparison therefore never
  matched, and every poll downloaded the entire feed again. It now follows the HTTP
  rules, which cover that case and several others.

- **A publish date in the future published immediately.** The episode form has always
  offered a date picker, so setting tomorrow looked exactly like scheduling. It also
  made the feed's build date churn every sixty seconds for as long as any episode
  carried a future date, which meant every subscriber re-downloaded the whole feed
  each time. See **Scheduled episodes** below.

- Removing, restoring or deleting an episode gave no confirmation when JavaScript was
  on — the message was assembled and then discarded. The same actions without
  JavaScript had always worked.

- `npm run scan` pointed at a script that does not exist.

### Added

- **Scheduled episodes.** A publish date in the future now holds an episode out of the
  feed until then, and it joins on its own at its time with nothing running and nobody
  clicking — within a minute, and visible to subscribers whenever their app next
  checks. The episode table, the show card and the episode page all say what is
  waiting and when. Nothing is stored to make this work: a scheduled episode is an
  ordinary one whose date has not arrived, so it needs no new state and cannot get
  stuck.

- **Directory readiness, on each show's page.** A checklist of everything that would
  make Apple Podcasts or Spotify refuse the feed — no artwork at all, artwork in a
  format they do not take, artwork outside 1400–3000px square, an empty description, no
  owner email. You used to find that out at submission time, or never. Each row links
  to the panel that fixes it, and the checks that already pass are kept, collapsed, so
  you can see what was looked at. It is deliberately not a banner and not a badge:
  most SelfPod feeds are private and will never be submitted anywhere.

  One of those checks is worth naming: a `cover.webp` is a perfectly good cover here
  and an outright rejection at Apple, and because artwork is served from a URL ending
  `cover.jpg` whatever the file really is, nothing about the address gave it away.

- **Per-episode artwork**, with nothing to fill in. SelfPod now reads the artwork
  embedded in an audio file's own tags, or an image left beside it with the same name
  (`my-episode.mp3` → `my-episode.jpg`). A sidecar wins over an embedded picture,
  because it is the one you can change without re-tagging. Extracted images are cached
  under `/data`, never written into your show folder.

- **Trailers and bonus episodes**, via a new *Episode type* on each episode. SelfPod
  never guesses this from a filename — `trailer-park ep 3.mp3` is not a trailer, and a
  wrong guess is invisible until an app orders the show oddly.

- **Serial shows**, for a podcast meant to be heard from the beginning rather than
  newest-first.

- **A switch to keep a show out of podcast directories.** A feed's URL is its own
  password, and this asks Apple and the others to leave it out of their index should it
  ever leak. It defaults to off, exactly as every feed has behaved until now, so
  nothing that is listed today can be de-listed by updating. Turning it on also refuses
  a deliberate submission — so readiness says so, rather than letting you wonder why
  Apple keeps declining.

- **Subscribers are forwarded after a public address change.** Changing the address
  used to break every subscription silently; each feed now carries a note pointing at
  the new one for sixty days, or until you say the move is done. There is no equivalent
  for a rotated feed token, and the modal now says so plainly: forwarding works by
  answering at the old address, and the point of rotating is that the old address stops
  answering.

- **Feeds are compressed**, which for a large one is roughly a twentieth of the bytes
  over a home connection. Compression happens once when the feed changes rather than
  once per poll, and audio is deliberately left alone — it is already compressed, and a
  content-coding there would break seeking.

- The category, subcategory and explicit flag applied to shows SelfPod discovers on its
  own are now editable in Settings. They have always existed and never had a way in, so
  every discovered show got "Technology".

- `<itunes:episodeType>` on every item, `<itunes:type>`, `<itunes:block>` when blocking
  is on, `<itunes:new-feed-url>` during a move, and the owner address on
  `<podcast:locked>` that the Podcasting 2.0 spec asks for.

## 1.4.0 — 2026-08-12

### Added

- **An episode timeline on Activity**, above the scan history. The scan log has always
  said "3 added" without saying *which* three — the only place a new episode's name
  appeared was the container log. The timeline names each episode, its show and the day
  it arrived, along with anything that later happened to it: went missing, removed from
  the feed, or dropped after the grace period. It needs no migration and no new
  bookkeeping, because it reads dates the episodes table has always carried, so it
  covers your whole library back to the first file you ever dropped in. The trade is
  stated on the page: it describes the state each episode is in now rather than a
  running log, so an episode that went missing and came back leaves no trace of having
  gone.

- **A period to measure Statistics over** — 7 days, 30 days, 90 days or all time —
  driving every figure, chart, table and log row on the page at once. Each headline
  number now carries how it compares with the period immediately before it. "412
  downloads" all-time could not tell you whether this month beat last; "+46% vs the
  previous 30 days" can. A rise from nothing is reported as a count rather than as
  "+100%", which would be a percentage measured from no data.

- **Two charts.** *Requests over time* stacks downloads and streams per day, and *Which
  apps are fetching* replaces the comma-separated list of app names with proportional
  bars — the list told you who was there but nothing about how much of your audience
  each one was. Both are drawn with ordinary HTML and CSS, with no charting library and
  no JavaScript, and both put their numbers in a table beside the picture so a screen
  reader gets data rather than ninety empty boxes.

- **Real filters on both logs.** The access log filters by period, show, request type
  and app, on top of failures-only, and sorts by time, size sent or result. The scan log
  filters by trigger and by outcome. Filter and sort state now lives in the address bar,
  so a filtered view survives a reload, can be bookmarked, and the Back button works.

- **A CSV export of the access log**, honouring whatever filters are active and holding
  every matching row rather than the page on screen. Titles containing commas, quotes or
  newlines survive the round trip, and a title beginning `=` is exported so a spreadsheet
  shows it as text instead of running it.

- **An "Added" column** on each show's episode table, and the same date on an episode's
  own page. `created_at` has always been recorded and never shown.

### Fixed

- **"Show older" no longer throws away the rows you were reading.** Both logs replaced
  the visible page with the next one, and the counter read "40 of 312" however deep you
  had gone. New rows are now appended below the ones already on screen, and the count
  says how many of the total you are actually looking at.

- **The scan log's "Load more" no longer nested a copy of the whole list inside itself**
  on every click, producing several elements sharing one id.

### Changed

- The Statistics per-show table drops its *Apps* column, which is now the app chart
  above it — and, with nothing needing per-show app lists, the page went from four
  database queries per show to two for all of them.

- The access log's list and total used to build their filters separately, which is how a
  filter reaches the rows but not the count. They now share one builder, so the "N of M"
  line cannot drift from what is on screen.

## 1.3.3 — 2026-08-12

### Changed

- **The dashboard no longer mentions periodic scanning at all.** How a volume behaves is
  reference information, not something to act on, so it belongs in one place rather than
  on the busiest page — and a notice you have to dismiss is still a notice you had to
  read first. **Settings → Live file detection** now always states the current mode:
  live events, checking every *n* minutes, or switched off, with the interval named.

### Removed

- The dashboard notice, its dismiss button and route, and the
  `watcher_notice_dismissed` setting it persisted — dead once the notice was gone, and
  the client handler had the dismiss URL hardcoded, so leaving it would have been a
  broken request waiting to happen. `watcherNoticeDismissed` is also gone from
  `/api/settings` and `/api/status`. An existing value in the database is inert and
  needs no migration.

## 1.3.2 — 2026-08-12

### Added

- **When a feed was last checked, and by which app**, under the feed-check count on a
  show's Reach panel and in the per-show table on Statistics. The count on its own did
  not answer the question people actually ask — *why hasn't my podcast app picked up the
  new episode?* — and the answer is usually that nothing has fetched the feed since it
  appeared. Podcast apps poll on their own schedule, and some (Pocket Casts among them)
  do it from their own servers rather than from the phone, so refreshing in the app only
  asks that server what it already knows.

## 1.3.1 — 2026-08-10

### Fixed

- **The "live file detection isn't available" banner no longer sits on every page.**
  On a network share, polling instead of file events is the permanent, expected state
  — there is nothing to fix and nothing to act on — but it was recorded as a *warning*,
  which put it in the banner reserved for faults, with no way to dismiss it. A banner
  that is always there is a banner nobody reads when something is genuinely broken.

  Health states can now be informational, and those stay out of the banner while still
  appearing in **Settings → Live file detection** and in `/api/status`. The dashboard
  still mentions it once, dismissibly. Switching live detection off yourself is treated
  the same way — being nagged about your own setting on every page is not a diagnostic.

  Real faults are unchanged and still banner loudly: a watcher that dies with `ENOSPC`,
  an unwritable data directory, a shows folder SelfPod cannot read.

## 1.3.0 — 2026-08-10

### Added

- **Rebuild a feed from disk**, in the Danger zone on a show page. SelfPod forgets
  every episode of that show and re-imports from the folder, taking titles, dates and
  descriptions from the files and their tags, and bringing back anything you had
  removed from the feed. No audio file is touched.

  For when a library has been renamed, re-tagged or re-encoded outside SelfPod and the
  feed no longer resembles the folder. **Try Rescan first** — it already detects
  replaced audio and costs subscribers nothing. Rebuilding mints new episode
  identities, so podcast apps treat the whole back catalogue as new, download it again,
  and lose what was marked played. It is confirmed twice for that reason, and recorded
  in the activity log.

### Fixed

- Confirmation gates evaluated each control independently, so a dialog asking for two
  confirmations unlocked on whichever one you touched last. Every control pointing at a
  button must now be satisfied — a double confirmation is now actually double.

## 1.2.1 — 2026-08-10

### Fixed

- **The episode table on a phone.** Titles were cut off mid-word: the table was forced
  to 620px on narrow screens and the pinned actions column sat on top of the text.
  Below 640px each row is now a stacked block — title, then a wrapped line of date,
  duration, size and fetches, with the actions in the corner. Wider screens are
  unchanged.
- **Pages no longer scroll sideways on a phone.** A long unbreakable string — a feed
  URL, a filesystem path — widened its column, then the card, then the document. Three
  containers were missing `min-width: 0`, which is also why the feed URL's ellipsis
  never appeared.

## 1.2.0 — 2026-08-10

### Security

- **A symlink inside a show folder is no longer followed out of it.** Anyone able to
  write to the media folder — often a network share — could point a symlink at a file
  elsewhere on the host and read it through the feed, which is usually reachable from
  the internet. Filenames are now resolved with `realpath` and required to land inside
  the show's own directory. A show folder that is itself a symlink to another dataset
  still works.
- **Response hardening headers**, previously absent: a content security policy with
  `script-src 'self'` and no `unsafe-inline` (every script in SelfPod is an external
  file, so injected markup cannot execute), plus `frame-ancestors 'none'`,
  `X-Frame-Options`, `nosniff` and `Referrer-Policy: no-referrer` — the last because a
  feed token is printed on the show page. HSTS is opt-in with `ENABLE_HSTS=1`, since a
  surprise HSTS header for a host also served over plain HTTP is a lockout.
- The public-address self-check is rate limited, and no longer returns a version string
  unless the reply proves it came from the same instance — otherwise that field handed
  back a slice of whatever answered.
- **35 adversarial tests** added to the suite, so CI gates on them: traversal through
  URLs, poisoned database rows and uploads; symlink escape; the static asset root;
  hostile filenames rendered into pages and into RSS; forged sessions; cross-origin
  mutations; password guessing with a spoofed `X-Forwarded-For`; feed-token enumeration.

### Added

- `docker-compose.yml` ships a capability drop and `no-new-privileges`. With them the
  app process runs with no effective capabilities at all, `NET_RAW` included.
- A Security section in the README: what is reachable without signing in, what files
  SelfPod will serve, and two things it cannot fix for you.

## 1.1.3 — 2026-08-10

### Fixed

- **The public-address test blamed DNS for problems in your browser.** A browser will
  not say why a cross-origin request failed, so the single failure path was guessing.
  SelfPod now also tests the address itself, and the two results give four honest
  verdicts: reachable; *blocked here* (the address is fine, this browser refused,
  listeners unaffected); *wrong server*; and unreachable with the real cause named —
  does not resolve, connection refused, certificate rejected, timed out.

### Added

- `/health` answers a `?ping=` nonce with a signature only that instance can compute,
  which is what makes "this address answers, but it is not this container" detectable.
  That misconfiguration is the quiet one: every page looks healthy while subscribers are
  served another container's feeds.

## 1.1.2 — 2026-08-10

### Fixed

- **Pocket Casts could not use the subscribe QR code.** Its subscribe scheme is a lookup
  in Pocket Casts' public directory, and a private SelfPod feed is in no directory — the
  app opened and reported that it could not find the podcast, while the same URL pasted
  into its search box worked immediately. That pane now gives the instruction that
  works, with a copy button and no QR. Apple Podcasts, Overcast and Castro take the feed
  by link and keep theirs.

## 1.1.1 — 2026-08-09

### Fixed

- **Every failed request now carries a reason.** Reading an episode can fail *after* its
  size has been checked — deleted between the two, or the storage dropping mid-transfer
  — and that reached the subscriber as a bare HTTP 500 recorded with no explanation. Any
  4xx or 5xx without one now gets a sentence naming the file and the likely cause. HTTP
  416 gets its own, because "the app cached a longer version of this episode" is a
  different problem from a missing file.

## 1.1.0 — 2026-08-09

### Added

- **Download and play statistics**, per episode and per show. Whole-file downloads and
  partial streams are counted separately, because one listener seeking through an
  episode produces dozens of the latter and merging them makes both figures
  meaningless. Neither is called a *listen* — no podcast server can know that.

  Failures are shown first and always explain themselves, which is the half that
  matters: a subscriber who cannot download an episode was previously invisible.
  Surfaces: a Statistics page, a Reach panel and per-episode counts on each show,
  per-file numbers with their own log on the episode page, and `GET /api/stats`,
  `/api/stats/log`, `/api/shows/:id/stats`.

  No IP addresses and no raw user agents are stored — only a coarse app family — and
  never the feed token, which appears in every one of those URLs. Requests you make
  while signed in, including previewing an episode, are excluded.
- Per-app subscribe QR codes on the show page, and `npm run reset-password` for an
  instance whose generated password has scrolled out of the container log.

### Fixed

- **Episodes with long filenames would not download.** Any URL path segment over 100
  characters was rejected before SelfPod's own code ran, so a real episode title of 106
  characters failed with "requested URL too long" in the podcast app and nothing in the
  logs to explain it. Filenames up to 512 characters now work — past the limit of every
  filesystem this runs on.
- Browser uploads work when the media folder and SelfPod's data are on separate mounts.

## 1.0.1 — 2026-08-09

### Fixed

- Defects found by an adversarial review of the finished code, including a show deleted
  while keeping its folder being silently re-adopted on the next scan, and one control
  character in a filename making an entire feed unparseable.

## 1.0.0 — 2026-08-09

First release. A folder is a show, a file in it is an episode, and each show gets a
private token-protected RSS feed with correct MIME types, stable episode GUIDs across
renames, and HTTP Range support. Everything stateful lives in one directory, so moving
to another machine is copying it.
