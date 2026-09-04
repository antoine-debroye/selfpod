# Changelog

Notable changes to SelfPod. Versions follow [semantic versioning](https://semver.org),
and images are published to `ghcr.io/antoine-debroye/selfpod` under the matching tag.

Updating is changing the image tag and redeploying. The database migrates itself
forward on start, and no release so far has needed anything else — where a release
changes what your listeners see, it says so.

## 1.8.3 — 2026-09-04

### Fixed

- **Changing `WHISPER_MODEL` did nothing to episodes already read.** The reason for
  pointing it at a larger model is that the larger one hears words the smaller one gets
  wrong — `small` catches a jingle over music that `base` drops. But a stored transcript
  recorded which model made it and nothing ever compared that, so every episode kept the
  words the old model heard. The owner would have made the change, waited, and watched
  the same words stay wrong. An episode whose transcript was made by a different model
  is now read again, newest first, as a backfill that never holds anything already
  published out of the feed.

## 1.8.2 — 2026-09-04

### Fixed

- **An episode already in a podcast app stopped downloading after it was re-cut.** An
  enclosure address carries the content version of the audio it names, and the media
  route refuses any other — it must, or an app resuming a half-finished download would
  be handed part of one cut and part of another and would join them into an episode
  that never existed. But an enclosure address lives in a subscriber's app for as long
  as that app keeps the episode, so every re-cut — a decision changed, an edge moved,
  two spellings of one read folded together — killed every address already out there.
  The app showed "Download Failed" over a hundred-byte error body, and retrying could
  not help, because the address it held could never work again.

  An address from an earlier cut now plays, provided the client is starting the file
  from the beginning: it receives a whole, consistent episode whichever cut it gets.
  Only a client assembling a file out of parts — resuming from the middle, or asking
  for the last few bytes — is still refused, because that is the one that could join
  two cuts together.
- **A missing cut copy no longer takes the whole feed down.** `/data/.trimmed` holds
  nothing that cannot be made again, which is what makes it safe to clear — and made
  clearing it answer 404 for every episode until each had been cut afresh. The episode
  you actually have is served instead, adverts and all, with a warning saying so and
  with nothing allowed to cache it. This is the trade §19.5 already makes for a trim
  that fails: an advert that survives explains itself the moment it is heard, and an
  episode that silently never appears does not.

## 1.8.1 — 2026-09-04

### Added

- **An episode says what was taken out of it.** Clicking an episode now shows how much
  shorter the published copy is than the file on your share, every stretch that was
  removed with the words and the reason for each, anything still waiting for you — which
  you can decide right there — and why the episode is being held out of the feed if it
  is. The words SelfPod heard sit underneath as the evidence, and every decision uses
  the same sentences as the show's Adverts page.

### Fixed

- **The audio preview on a trimmed episode played nothing at all.** The page linked the
  original file while the media route serves the published copy and checks its content
  version, so the player got a refusal and did nothing — silently. The preview now
  resolves the published copy when you press play rather than when the page was drawn,
  so it also survives the audio being cut again while the page is open.

- **“Already decided” was unreadable.** The row was a single line of flex carrying six
  things, so the position label was squeezed to no width at all and printed straight
  over the decision beside it — “Varies” and “Removed” on top of each other — while the
  words and the reason were crushed into two narrow columns and the reversal button was
  pushed off the edge of the card. Everything describing a segment now stacks in one
  column and wraps there, and only the reversal sits beside it.
- **One read is one row.** Every way the recogniser wrote the same closing tag became a
  segment of its own, so the same sponsor read was offered four times and four rows of
  the catalogue recorded the same decision. Variants are now recognised by aligning the
  shorter wording inside the longer, and folded together — never across a disagreement,
  and never swallowing a phrase two reads merely share, such as a jingle that follows
  one of them.
- **A decision now beats an open question.** When an undecided candidate and a decided
  read covered the same words, whichever ran first took them, and a candidate winning
  meant the owner's own decision stopped being applied to that episode.
- A segment whose episodes have all gone said its position was “Varies”; it now says it
  is not in an episode you have any more. It is still kept, because a segment is how
  SelfPod remembers a decision and the same words can arrive again tomorrow.
- “Repeats across 1 episodes”, and a wordless row that gave its episode count twice.
- The reversal button says the short thing — “Put it back” — with what else it undoes
  written under it, rather than a sentence too long to sit in a row.

## 1.8.0 — 2026-09-04

### Added — SelfPod hears the words

- **Spoken-advert detection.** SelfPod now transcribes the opening and closing minutes
  of each MP3 episode on the box itself, with whisper.cpp, and looks for sponsor reads
  in the *words*: the same words day after day even when a host reads them live, and
  wording that sounds like an advert — a promo code, "brought to you by", a web
  address, and the small print French law makes advertisers say. Nothing leaves the
  machine. (spec §19.6)
- **Boundaries.** On any episode page, pick the words the programme starts with —
  "Vous écoutez RMC" — and press *The programme starts here*: everything before them
  is cut, in every episode where SelfPod hears them, whatever it is. The way to
  remove a pre-roll that is a different advert every day. *The programme ends here*
  does the same for the tail.
- **Memory.** Remove a read once and the same words are cut from later episodes
  without asking, in review mode too; keep one and it is never offered again. Approved
  and rejected reads *are* the memory.
- **A card you can read.** Each candidate found by the words shows the transcript
  with the cut marked and a few seconds of context, the cues that fired, and one
  sentence saying what SelfPod will do and why. Tap a word to move an edge; the
  player carries three seconds either side so the edges can be judged by ear.
- **What SelfPod heard**, on the episode page: the words with cuts struck through and
  candidates highlighted, and the place to teach it.
- The subscription ledger says what the words meant for each episode — heard and
  waiting, cut from memory, cut at the boundary, could not be read.
- *Where to listen* per show: first N minutes, last N minutes, or the whole episode.
  The page quotes the measured speed once it has heard something.
- `WHISPER_MODEL=base` (default) or `small`: both ship in the image. `small` is about
  twice the work and markedly better in French; `WHISPER_CLI` and `WHISPER_MODEL`
  also accept paths.

### Changed

- A stretch found by ear at the very start of an episode is no longer held as a
  theme tune once its words say sponsor.
- The migration rebuilds the advert catalogue to widen a CHECK constraint; every
  segment, decision and cut survives, and an older image still runs against it.
- The image builds whisper.cpp from a pinned tag, in AVX2 and SSE4.2 flavours for
  amd64 chosen at boot, and proves every binary against every model on a one-second
  file before the image is accepted. About 260 MB larger.

## 1.7.0 — 2026-08-28

### Added

- **The list of every episode a followed feed has offered can now be searched, filtered
  and paged.** A feed followed for a while has hundreds of entries — a handful in your
  feed and the rest refused, nearly all of them for the same reason. There is now a
  search box (title or filename), a "what happened" filter listing every decision with
  how many entries it holds, a "published" filter for the last 7, 30 or 90 days, and a
  "Show older" button that says how much of the list you are looking at. Every filter
  survives a reload, a bookmark and a browser with JavaScript switched off, because
  they are in the address bar.
- **Episodes can be ticked and fetched together.** Each entry has a checkbox, with a
  select-all for everything on screen, and one button queues the lot — so bringing back
  a month of episodes you skipped is a filter, a tick and a click rather than forty
  separate ones. Nothing downloads when you press it: the selection joins the queue and
  each check takes up to 25 of them, which the button says next to it. Episodes refused
  because their audio sits on a private address have no checkbox, and are refused again
  if one is sent by hand.

### Fixed

- **That same list quietly stopped at the first hundred entries.** It fetched a hundred
  rows, showed them, and said nothing about the rest. On the feed this was found on, 402
  of 502 entries were simply not on the page — on the one page in SelfPod whose entire
  job is to account for every episode a feed has offered.
- **The subscription page was rendering half-unstyled.** It had been built out of class
  names the stylesheet never had — the status panel, the state of each entry, the
  refusal notes and the table itself all fell back to browser defaults. It is now built
  from the same components as the rest of the app: the table is the episode table, the
  states are the same badges used everywhere else, and it stacks into readable blocks on
  a phone rather than scrolling the "what happened" column off the screen.
- **A confirmation was being dropped on the floor after removing an episode from the
  feed.** With JavaScript on, "Remove from feed" swapped the table and said nothing —
  the message was rendered into a response that had already been sent. It had been
  fixed once before and silently regressed; there is now a test that fails if it goes
  quiet again.
- **The reason an episode was skipped was repeated on every row it applied to.** Four
  hundred rows carried the same sentence about the backfill limit. It is now printed
  once at the top of a run of identical ones and kept on every row as a tooltip, so the
  column reads as a column instead of a wall.

## 1.6.4 — 2026-08-27

### Fixed

- **"Download again" did nothing until the feed happened to change.** Asking for a
  deleted episode back queues it for the next check, and a check of a feed that has not
  changed is answered "nothing new" — at which point SelfPod stopped, leaving the
  episode queued. On a show that publishes daily you would have got it within the hour;
  on a quiet one it could wait days, with the button appearing to do nothing and saying
  nothing about it. "No new episodes" is not the same as "nothing to do", and the same
  applies to a download that failed and was waiting for another attempt.

## 1.6.3 — 2026-08-27

### Added

- **The episode list now says when SelfPod means to fetch an episode a second time,
  and why.** That second fetch is how adverts inserted at serve time are found — what
  differs between two downloads of one episode cannot be the theme tune — but it also
  spends your bandwidth and counts again in the publisher's listener figures. It was
  happening silently. Each affected episode now says so before it happens (*"will fetch
  this one again tomorrow, because it runs 22s longer than the 251s the feed states"*)
  and what came of it afterwards.

### Fixed

- **An acceptance check reported a fault in SelfPod when the real problem was a busy
  machine.** It waited a fixed eight seconds for a container to boot and then asserted
  on its log; under load that was not long enough, so it failed twice in a row while
  the app behaved perfectly. It now waits for the thing it is checking, as the rest of
  the suite does. Nothing in the app changed — but a check that cries wolf is worse
  than no check, because the next real failure gets shrugged at.

## 1.6.2 — 2026-08-27

### Fixed

- **An advert stitched in as the episode is sent was invisible.** SelfPod decided
  whether an episode was worth downloading a second time — the check that finds adverts
  a host inserts on the way out — by reading the file's own structure: a change of
  format part-way through, a header disagreeing with its contents, untidy joins. A host
  that serves cleanly encoded audio shows none of that, so the file looks innocent and
  the check never ran.

  It now also compares the file against the length the feed claims for it. A publisher
  states how long an episode runs and does not revise that number when an advert is
  added on the way out, so audio past the stated length is audio the publisher did not
  count. Found on a real show: five episodes declared between 1:14 and 4:11, each
  arriving 21 to 23 seconds longer, with an advert on the end — and not one of the
  older signals fired on any of them.

- **A show could be told it had nothing repeated in it before anything had been
  compared.** Reading a show means decoding every episode, which takes a while; the
  adverts page counted the MP3 files in the folder instead of the episodes it had
  actually listened to, so it announced "compared 5 episodes and found no repeated
  audio" the moment a show was switched on. On a real show it said exactly that, and a
  minute later three segments were sitting underneath the sentence denying they
  existed. It now counts what it has heard.

## 1.6.1 — 2026-08-27

### Fixed

- **Neither switch in Settings did anything.** Turning "Follow podcast feeds" on — or
  "Live file detection" off — appeared to work and then sprang back, because the
  setting was never saved. Both switches asked the browser to run a snippet of
  JavaScript written into the page itself, and SelfPod deliberately tells browsers not
  to run those: it is the rule that stops an injected script doing anything, and it is
  worth keeping. The browser therefore refused, and refused *silently* — no error
  anywhere, nothing in the log, no request made.

  The consequence was worse than a stiff switch. "Follow podcast feeds" is off until
  you turn it on, and it could not be turned on, so following a feed could not be set
  up at all in 1.6.0 — the feature was unreachable from the moment it shipped.

  Both switches now work, and a test refuses to let any page carry that kind of
  in-page JavaScript again, since the security rule above is written down as something
  the app relies on being true.

## 1.6.0 — 2026-08-27

### Added

- **Follow a podcast feed and keep only the episodes you want.** Point SelfPod at a
  show's feed, set the rules — words that must appear in the title, words that must
  not, a shortest and longest length — and it downloads only the matching episodes
  into that show's folder. From there they are ordinary episodes: on your share, in
  your own private feed, in whatever podcast app you already use.

  Everything it decides is written down, including the refusals. The show's
  subscription page lists every episode the feed has ever offered and what happened to
  each one — *"skipped because the title contains `bonus`"*, *"skipped because it runs
  4:12, under the 20:00 minimum"*. "Where is that episode?" was the question worth
  being able to answer.

  Before committing to anything, **Preview what would match** fetches the feed and
  shows you which of its recent episodes would be taken and exactly why the rest would
  not, without downloading a byte or recording anything.

  Some points worth knowing:

  - **It is off by default**, and turning it on is a real decision rather than a
    formality. Until you do, SelfPod's outbound behaviour is byte-for-byte what it has
    always been. See the security section of the README for what changes when you
    switch it on, and what stays true regardless.
  - **Loosening a rule brings episodes back.** Remove a keyword you had been excluding
    and the episodes it was skipping are re-checked on the next look — the page tells
    you how many before you save. Tightening a rule never removes anything already
    downloaded.
  - **A feed that omits episode lengths** is handled by downloading and measuring,
    then discarding what falls outside your range. A length the feed *does* state is
    trusted rather than second-guessed.
  - **Deleting an episode is final.** SelfPod will not download it again on the next
    check. There is a "Download again" button for when you change your mind.
  - Removing a subscription never touches the episodes it already downloaded.

- **Cut the adverts out of your episodes.** SelfPod can find audio that repeats
  across a show — the sponsor read that opens every episode, the bed under the
  credits — and remove it from all of them. Set it per show, under **Adverts**.

  **How it recognises audio.** SelfPod decodes a low-quality copy of each episode and
  fingerprints the sound rather than the bytes, so it finds a theme tune or a sponsor
  read even though every episode's copy of it was encoded separately and shares almost
  no data with the others. That is the normal case: a podcast is mixed and encoded in
  one pass. It survives a change of bitrate and a change of volume.

  This adds one dependency, an MP3 decoder of about eighty kilobytes that runs
  in-process in a WebAssembly sandbox. It is LGPL-2.1 rather than MIT like the rest of
  SelfPod, so the image label now says so and `THIRD-PARTY-LICENSES.md` records what
  that obliges. It is emphatically not ffmpeg: no GPL, no video decoders, no subprocess,
  and eighty kilobytes rather than eighty megabytes.

  **It does not know what an advert is, and never claims to.** A theme tune, a
  sponsor read, a standing intro and a recurring stinger repeat in exactly the same
  way, and nothing in the audio tells them apart. So SelfPod shows you what it found
  — how long, how many episodes carry it, whereabouts it sits, and a player so you
  can hear the segment on its own — and you decide. There is an automatic mode for
  when you would rather not be asked each time, and even then it refuses on its own
  to cut anything that always sits at the very start or the very end, because that is
  where a theme and credits live.

  - **Your files are never modified.** The trimmed copy lives with SelfPod's other
    derived data and can be deleted whenever you like; the originals in your show
    folders are exactly as you left them. Change your mind and the episodes go back.
  - **Nothing is decoded or re-encoded.** What your subscribers download is
    byte-identical to your original everywhere except a few milliseconds either side
    of a join, so no quality is lost, and cutting an hour-long episode takes about a
    thirtieth of a second. SelfPod ships no `ffmpeg` and does not need one.
  - **Episodes are held back until the decision is settled**, rather than published
    and swapped afterwards. Podcast apps download in pieces and resume, so changing an
    episode's audio underneath a listener who is part-way through would hand them half
    of one file and half of another, with nothing to notice. How many are waiting, and
    why, is stated on the show's page.
  - **Adverts a host inserts as it serves** are found by downloading one episode a
    second time, a day later, and comparing — whatever changed cannot be the theme
    tune. This is done sparingly on purpose: a second download counts again in the
    publisher's listener figures, so it happens only for episodes whose audio shows
    real signs of having been stitched together, and never by disguising SelfPod to
    defeat a host's caching.
  - `.mp3` only for now. Other formats are published untouched.

### Fixed

- **A copy interrupted part-way could leave a file the scanner then complained about.**
  When a show's folder is on a different filesystem from SelfPod's own data — the usual
  arrangement on a NAS — a move is done as a copy, and the temporary file it used was
  visible to the library scan. A scan landing at the wrong moment reported *"`episode.
  mp3.selfpod-incoming` was ignored because SelfPod doesn't serve that file type"*: a
  warning about SelfPod's own working file, blamed on the user. It is now hidden from
  the scan, and cleaned up if the copy dies.

- **`@fastify/rate-limit` had been installed and never switched on.** The only limit in
  the app was a hand-written one inside the public-address self-test. It is now
  registered properly and applied to the handful of admin actions that warrant it —
  and deliberately *not* to media, feeds or ordinary pages, where a shared limit behind
  a reverse proxy would have turned every listener into one bucket.

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

### Also in this release

These were written as 1.4.0 and never published on their own, so they ship here rather
than under a version number no image was ever built for.

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
