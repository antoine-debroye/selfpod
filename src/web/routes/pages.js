import { PREVIOUS_BASE_URL_WINDOW_DAYS, SCAN_TRIGGER, SHOW_STATUS } from '../../constants.js';
import { notFound } from '../../lib/errors.js';
import { bucketEdges, DEFAULT_RANGE, RANGES, resolveRange } from '../../lib/time-range.js';
import { normaliseBaseUrl } from '../../lib/urls.js';
import { SCAN_OUTCOMES } from '../../services/activity.js';
import { ACCESS_KIND, NO_ACCESS } from '../../services/stats.js';
import { TIMELINE_EVENT } from '../../services/timeline.js';
import { SETTING_KEYS } from '../../services/settings.js';
import { MIN_PASSWORD_LENGTH } from '../../routes/api/setup.js';
import { subscribeQrCodes } from '../lib/qr.js';
import { DEFAULT_SUBSCRIBE_TARGET } from '../lib/subscribe-links.js';

const APP_LAYOUT = { layout: 'layouts/app.eta' };
const BARE_LAYOUT = { layout: 'layouts/bare.eta' };

/**
 * Full-page routes (spec §11.1).
 *
 * Every form on these pages is a real `<form method="post">` that works without
 * JavaScript: the POST handler redirects back with a flash message. When htmx is
 * present it intercepts the same URL and gets a fragment instead, which is the
 * single form-handling pattern used throughout the app.
 */
export default async function pageRoutes(fastify, services) {
  const { config, settings, shows, episodes, activity, health, watcher, presentShow, presentEpisode } = services;

  /** Shared context every page in the app shell needs. */
  function shell(request, extra = {}) {
    const baseUrl = settings.publicBaseUrl();
    let host = null;
    if (baseUrl) {
      try {
        host = new URL(baseUrl).host;
      } catch {
        host = baseUrl;
      }
    }
    return {
      username: request.session?.get?.('admin')?.username ?? settings.adminUsername(),
      publicBaseUrl: baseUrl,
      publicBaseUrlHost: host,
      showsDir: config.showsDir,
      // Read from the in-memory registry, so the banner renders even when the
      // database or the shows folder cannot be read (spec §13.1).
      issues: health.banners(),
      shows: shows.listActive().map((show) => ({ slug: show.slug, title: show.title })),
      flash: consumeFlash(request),
      ...extra,
    };
  }

  function consumeFlash(request) {
    const flash = request.session?.get?.('flash') ?? null;
    if (flash) request.session.set('flash', null);
    return flash;
  }

  function setFlash(request, message, level = 'ok') {
    request.session.set('flash', { message, level });
  }
  services.setFlash = setFlash;
  services.shellContext = shell;

  /**
   * Anything inside the app shell requires a session, and redirects into the
   * wizard until it has been completed.
   */
  const guarded = {
    preHandler: async (request, reply) => {
      const result = await fastify.requireAdminPage(request, reply);
      if (reply.sent) return result;
      if (!settings.setupComplete()) return reply.redirect('/setup', 303);
      return undefined;
    },
  };

  /* --------------------------------------------------------------- sign in */

  fastify.get('/login', async (request, reply) => {
    if (fastify.isAuthenticated(request)) return reply.redirect('/', 303);
    return reply.view(
      'pages/login.eta',
      {
        title: 'Sign in',
        next: sanitiseNext(request.query?.next),
        firstRun: settings.mustChangePassword(),
        error: request.query?.error === 'invalid' ? 'That username and password combination is not correct.' : null,
        issues: health.banners(),
      },
      BARE_LAYOUT,
    );
  });

  fastify.post('/login', async (request, reply) => {
    const { username, password, next } = request.body ?? {};
    const result = await fastify.verifyCredentials(username, password, request);

    if (!result.ok) {
      reply.status(401);
      return reply.view(
        'pages/login.eta',
        {
          title: 'Sign in',
          next: sanitiseNext(next),
          username,
          firstRun: settings.mustChangePassword(),
          error: result.message,
          issues: health.banners(),
        },
        BARE_LAYOUT,
      );
    }

    request.session.set('admin', { username: result.username, since: new Date().toISOString() });
    await request.session.save();

    if (!settings.setupComplete()) return reply.redirect('/setup', 303);
    return reply.redirect(sanitiseNext(next) || '/', 303);
  });

  fastify.post('/logout', async (request, reply) => {
    await request.session.destroy();
    return reply.redirect('/login', 303);
  });

  /* ----------------------------------------------------------------- setup */

  /**
   * The wizard is behind the session on purpose: bootstrap always creates a
   * credential before the server listens, so an instance exposed through a tunnel
   * before its first sign-in cannot be claimed by whoever finds it first.
   */
  const setupGuard = {
    preHandler: async (request, reply) => {
      const result = await fastify.requireAdminPage(request, reply);
      if (reply.sent) return result;
      if (settings.setupComplete() && !request.query?.revisit) return reply.redirect('/', 303);
      return undefined;
    },
  };

  fastify.get('/setup', setupGuard, async (request, reply) =>
    reply.redirect(settings.mustChangePassword() ? '/setup/1' : '/setup/2', 303),
  );

  for (const step of [1, 2, 3]) {
    fastify.get(`/setup/${step}`, setupGuard, async (request, reply) =>
      reply.view('pages/setup.eta', setupContext(step), BARE_LAYOUT),
    );
  }

  function setupContext(step, extra = {}) {
    const defaults = settings.defaults();
    return {
      title: 'Set up SelfPod',
      step,
      issues: health.banners(),
      publicBaseUrl: settings.publicBaseUrl() ?? config.publicBaseUrl ?? '',
      envPrefilled: Boolean(config.publicBaseUrl),
      defaultAuthorName: defaults.authorName,
      defaultAuthorEmail: defaults.authorEmail,
      defaultLanguage: defaults.language,
      ...extra,
    };
  }

  fastify.post('/setup/1', setupGuard, async (request, reply) => {
    const { password, passwordConfirm } = request.body ?? {};
    const errors = {};
    if (String(password ?? '').length < MIN_PASSWORD_LENGTH) {
      errors.password = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
    } else if (password !== passwordConfirm) {
      errors.passwordConfirm = "Those two passwords don't match.";
    }
    if (Object.keys(errors).length) {
      reply.status(422);
      return reply.view('pages/setup.eta', setupContext(1, { errors }), BARE_LAYOUT);
    }
    await fastify.setAdminPassword(password);
    return reply.redirect('/setup/2', 303);
  });

  fastify.post('/setup/2', setupGuard, async (request, reply) => {
    const normalised = normaliseBaseUrl(String(request.body?.publicBaseUrl ?? ''));
    if (!normalised) {
      reply.status(422);
      return reply.view(
        'pages/setup.eta',
        setupContext(2, {
          errors: {
            publicBaseUrl:
              'Include the scheme and host, for example https://podcast.example.com — this is the address your reverse proxy serves SelfPod on.',
          },
        }),
        BARE_LAYOUT,
      );
    }
    settings.update({ [SETTING_KEYS.PUBLIC_BASE_URL]: normalised });
    return reply.redirect('/setup/3', 303);
  });

  fastify.post('/setup/3', setupGuard, async (request, reply) => {
    const body = request.body ?? {};
    const email = String(body.defaultAuthorEmail ?? '').trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      reply.status(422);
      return reply.view(
        'pages/setup.eta',
        setupContext(3, { errors: { defaultAuthorEmail: "That doesn't look like an email address." } }),
        BARE_LAYOUT,
      );
    }
    settings.update({
      [SETTING_KEYS.DEFAULT_AUTHOR_NAME]: String(body.defaultAuthorName ?? '').trim().slice(0, 200),
      [SETTING_KEYS.DEFAULT_AUTHOR_EMAIL]: email.slice(0, 200),
      [SETTING_KEYS.DEFAULT_LANGUAGE]: String(body.defaultLanguage ?? 'en').trim().toLowerCase() || 'en',
      [SETTING_KEYS.SETUP_COMPLETE]: '1',
    });
    // Shows found by the startup scan predate these defaults, so fill their blanks
    // now rather than leaving every card flagged for a missing author email.
    shows.applyDefaultsToBlankShows();
    setFlash(request, 'SelfPod is ready. Drop a file into a show folder and it becomes an episode.');
    return reply.redirect('/', 303);
  });

  /* ------------------------------------------------------------- dashboard */

  fastify.get('/', guarded, async (request, reply) => {
    const all = shows.list().map((show) => presentShow(show));
    return reply.view(
      'pages/dashboard.eta',
      shell(request, {
        title: 'Dashboard',
        crumbs: [{ label: 'Dashboard' }],
        shows: all.filter((s) => s.status === SHOW_STATUS.ACTIVE),
        pausedShows: all.filter((s) => s.status === SHOW_STATUS.FOLDER_MISSING),
        lastScan: activity.latestGlobal(),
        topbarActions: dashboardActions(),
      }),
      APP_LAYOUT,
    );
  });

  /* ------------------------------------------------------------- new show */

  fastify.get('/shows/new', guarded, async (request, reply) =>
    reply.view(
      'pages/show-new.eta',
      shell(request, { title: 'New show', crumbs: [{ label: 'Dashboard', href: '/' }, { label: 'New show' }] }),
      APP_LAYOUT,
    ),
  );

  fastify.post('/shows/new', guarded, async (request, reply) => {
    try {
      const show = await shows.create({ title: request.body?.title, slug: request.body?.slug });
      await services.scanner.scanShowNow(show.id, 'manual');
      setFlash(request, `“${show.title}” is ready. Drop audio into ${shows.dirFor(show)}.`);
      return reply.redirect(`/shows/${encodeURIComponent(show.slug)}`, 303);
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      reply.status(err.status);
      return reply.view(
        'pages/show-new.eta',
        shell(request, {
          title: 'New show',
          crumbs: [{ label: 'Dashboard', href: '/' }, { label: 'New show' }],
          title_: request.body?.title,
          slug: request.body?.slug,
          errors: err.fields ?? { title: err.message },
        }),
        APP_LAYOUT,
      );
    }
  });

  /* ----------------------------------------------------------- show detail */

  fastify.get('/shows/:slug', guarded, async (request, reply) => {
    const show = shows.getBySlug(request.params.slug);
    if (!show) throw notFound('That show does not exist.', 'show_not_found');
    const presented = presentShow(show, { includeEpisodes: true, includeReadiness: true });

    return reply.view(
      'pages/show-detail.eta',
      shell(request, {
        title: show.title,
        activeSlug: show.slug,
        crumbs: [{ label: 'Dashboard', href: '/' }, { label: show.title }],
        show: presented,
        subscribeCodes: await subscribeQrCodes(presented.feedUrl),
        defaultSubscribeTarget: DEFAULT_SUBSCRIBE_TARGET,
        topbarActions: showActions(show.slug),
      }),
      APP_LAYOUT,
    );
  });

  /* ---------------------------------------------------------- episode edit */

  fastify.get('/shows/:slug/episodes/:id', guarded, async (request, reply) => {
    const show = shows.getBySlug(request.params.slug);
    if (!show) throw notFound('That show does not exist.', 'show_not_found');
    const episode = episodes.get(request.params.id);
    if (!episode || episode.show_id !== show.id) {
      throw notFound('That episode does not exist.', 'episode_not_found');
    }

    return reply.view(
      'pages/episode-edit.eta',
      shell(request, {
        title: episode.title,
        activeSlug: show.slug,
        crumbs: [
          { label: 'Dashboard', href: '/' },
          { label: show.title, href: `/shows/${encodeURIComponent(show.slug)}` },
          { label: 'Edit episode' },
        ],
        show: presentShow(show),
        episode: presentEpisode(episode, show),
        episodeLog: services.stats.list({ episodeId: episode.id, limit: 15 }),
        episodeLogTotal: services.stats.count({ episodeId: episode.id }),
      }),
      APP_LAYOUT,
    );
  });

  /* ---------------------------------------------------------------- upload */

  fastify.get('/shows/:slug/upload', guarded, async (request, reply) => {
    const show = shows.getBySlug(request.params.slug);
    if (!show) throw notFound('That show does not exist.', 'show_not_found');
    return reply.view(
      'pages/upload.eta',
      shell(request, {
        title: `Upload to ${show.title}`,
        activeSlug: show.slug,
        crumbs: [
          { label: 'Dashboard', href: '/' },
          { label: show.title, href: `/shows/${encodeURIComponent(show.slug)}` },
          { label: 'Upload' },
        ],
        show: presentShow(show),
        maxUploadSizeMb: config.maxUploadSizeMb,
      }),
      APP_LAYOUT,
    );
  });

  /* -------------------------------------------------------------- activity */

  fastify.get('/activity', guarded, async (request, reply) =>
    reply.view('pages/activity.eta', shell(request, activityContext(request)), APP_LAYOUT),
  );

  /* ----------------------------------------------------------- statistics */

  /**
   * Downloads, streams and — the reason this page earns its place in the nav —
   * every request that failed. An episode that will not download in a podcast app
   * was previously invisible to SelfPod; now it is a row here with a reason.
   */
  fastify.get('/stats', guarded, async (request, reply) =>
    reply.view('pages/stats.eta', shell(request, statsContext(request)), APP_LAYOUT),
  );

  /**
   * The filtered access log as a file.
   *
   * A page route rather than a `/ui/` fragment: it is a navigation that produces a
   * file, so it must behave the same with JavaScript off, and an expired session
   * should land on the sign-in page rather than write a JSON 401 into someone's
   * downloads folder. Paging is ignored on purpose — what is on screen is a window,
   * the export is what the filters describe.
   */
  const CSV_MAX_ROWS = 50_000;

  const CSV_COLUMNS = [
    'requested_at_utc',
    'show',
    'episode',
    'filename',
    'kind',
    'status_code',
    'result',
    'bytes_sent',
    'total_bytes',
    'range_header',
    'app',
    'error',
  ];

  /** Leading characters a spreadsheet treats as the start of a formula. */
  const FORMULA_START = /^[=+\-@\t\r]/;

  function csvCell(value) {
    if (value === null || value === undefined) return '';
    const text = String(value);
    // An episode title genuinely can begin with "-" or "@". Prefixing an apostrophe is
    // the standard defusal: a spreadsheet shows the text instead of evaluating it, and
    // anything reading the file as data sees one extra character rather than a formula.
    const safe = FORMULA_START.test(text) ? `'${text}` : text;
    return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
  }

  fastify.get('/stats/access-log.csv', guarded, async (request, reply) => {
    const filter = logFilter(request);
    const rows = services.stats.list({ ...filter.query, limit: CSV_MAX_ROWS, offset: 0 });

    const lines = [CSV_COLUMNS.join(',')];
    for (const row of rows) {
      lines.push(
        [
          row.requestedAt,
          row.showTitle,
          row.episodeTitle,
          row.episodeFilename,
          row.kind,
          row.statusCode,
          row.ok ? (row.incomplete ? 'partial' : 'ok') : 'failed',
          row.bytesSent,
          row.totalBytes,
          row.rangeHeader,
          row.client,
          row.error,
        ]
          .map(csvCell)
          .join(','),
      );
    }

    const parts = ['selfpod-access-log', filter.slug ?? 'all-shows', filter.range.key];
    if (filter.failuresOnly) parts.push('failures');
    if (filter.kind) parts.push(filter.kind);
    const filename = `${parts.join('_')}.csv`;

    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${filename}"`);
    reply.header('cache-control', 'no-store');
    // A BOM, so a spreadsheet opens an accented episode title as UTF-8 rather than
    // as mojibake — the difference between a working export and a support question.
    return reply.send(`﻿${lines.join('\r\n')}\r\n`);
  });

  const LOG_PAGE_SIZE = 40;

  /** Sortable columns of the access log, in the order the headers appear. */
  const LOG_SORTS = ['time', 'bytes', 'status'];

  const KIND_OPTIONS = [
    { value: ACCESS_KIND.DOWNLOAD, label: 'Downloads' },
    { value: ACCESS_KIND.STREAM, label: 'Streams' },
    { value: ACCESS_KIND.FEED, label: 'Feed checks' },
    { value: ACCESS_KIND.COVER, label: 'Artwork' },
  ];

  const RANGE_OPTIONS = Object.entries(RANGES).map(([key, spec]) => ({
    key,
    label: spec.label,
    // The chips are narrow, so they carry the short form and the label is the title.
    chip: key === 'all' ? 'All time' : `${spec.days} days`,
  }));

  /**
   * The keys that describe a stats view, in a fixed order.
   *
   * `offset` is deliberately absent. It is real request state, but a URL carrying
   * offset=80 reloads into a log that begins eighty rows in, with the eighty rows the
   * reader had already worked through simply gone.
   */
  const STATS_URL_KEYS = ['range', 'showId', 'kind', 'client', 'failuresOnly', 'sort', 'dir'];
  const ACTIVITY_URL_KEYS = ['event', 'timelineShow', 'showId', 'trigger', 'outcome'];

  function toQueryString(keys, params) {
    const search = new URLSearchParams();
    for (const key of keys) {
      const value = params[key];
      if (value === null || value === undefined || value === '') continue;
      search.set(key, String(value));
    }
    return search.toString();
  }

  function positiveInt(value) {
    const parsed = Number.parseInt(value ?? '0', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  function resolveShow(value) {
    if (!value) return null;
    const key = String(value);
    return shows.getBySlug(key) ?? shows.get(key) ?? null;
  }

  /**
   * The single place a stats filter is read from a request and written back into a URL.
   *
   * The page, the htmx fragments and the CSV export all go through this. Templates used
   * to hand-assemble the round-trip URL out of the two filters that existed; with eight
   * of them, that hand-assembly is exactly where "Show older" or "Export" quietly drops
   * one and nobody notices until the numbers disagree.
   */
  function logFilter(request) {
    const query = request.query ?? {};
    const show = resolveShow(query.showId);
    const range = resolveRange(String(query.range ?? ''), { timeZone: config.timeZone });
    const kind = KIND_OPTIONS.some((k) => k.value === query.kind) ? String(query.kind) : null;
    const rawClient = typeof query.client === 'string' ? query.client.trim() : '';
    const client = rawClient ? rawClient.slice(0, 60) : null;
    const failuresOnly =
      query.failuresOnly === '1' || query.failuresOnly === 'true' || query.failuresOnly === 'on';
    const sort = LOG_SORTS.includes(String(query.sort)) ? String(query.sort) : 'time';
    const dir = String(query.dir).toLowerCase() === 'asc' ? 'asc' : 'desc';

    // Defaults are omitted from the written URL, so a plain /stats stays clean and two
    // routes that mean the same thing produce the same string.
    const params = {
      range: range.key === DEFAULT_RANGE ? null : range.key,
      showId: show?.slug ?? null,
      kind,
      client,
      failuresOnly: failuresOnly ? '1' : null,
      sort: sort === 'time' ? null : sort,
      dir: dir === 'desc' ? null : dir,
    };

    return {
      slug: show?.slug ?? null,
      range,
      kind,
      client,
      failuresOnly,
      sort,
      dir,
      offset: positiveInt(query.offset),
      /** Exactly what stats.list / count accept. Nothing else builds one. */
      query: {
        showId: show?.id ?? null,
        from: range.from,
        to: range.to,
        kinds: kind ? [kind] : null,
        client,
        failuresOnly,
        sort,
        dir,
      },
      params,
      /** Canonical query string minus offset; pagers append their own. */
      qs: toQueryString(STATS_URL_KEYS, params),
      /** Same filter, different sort — and the opposite direction if it is already active. */
      sortLink(key) {
        return toQueryString(STATS_URL_KEYS, {
          ...params,
          sort: key === 'time' ? null : key,
          dir: sort === key && dir === 'desc' ? 'asc' : null,
        });
      },
    };
  }
  services.logFilter = logFilter;

  function statsPageUrl(filter, patch = {}) {
    const query = toQueryString(STATS_URL_KEYS, { ...filter.params, ...patch });
    return query ? `/stats?${query}` : '/stats';
  }
  services.statsPageUrl = statsPageUrl;

  /**
   * Buckets for the chart.
   *
   * All time starts at the oldest request rather than at an arbitrary date, and ends
   * where any range ends — tomorrow's local midnight, so today's partial day counts.
   */
  function chartBuckets(range) {
    const to = range.to ?? resolveRange(DEFAULT_RANGE, { timeZone: config.timeZone }).to;
    const from = range.from ?? services.stats.firstAccessAt();
    if (!from) return [];
    return bucketEdges({ from, to, timeZone: config.timeZone });
  }

  function statsContext(request) {
    const filter = logFilter(request);
    const { range } = filter;
    const scope = { from: range.from, to: range.to };

    const entries = services.stats.list({
      ...filter.query,
      limit: LOG_PAGE_SIZE,
      offset: filter.offset,
    });
    const total = services.stats.count(filter.query);

    // One grouped query for every show, rather than four per show in a loop.
    const rollups = services.stats.forShows(scope);
    const clients = services.stats.byClient(scope);

    return {
      title: 'Statistics',
      active: 'stats',
      crumbs: [{ label: 'Statistics' }],
      overview: services.stats.overview({ ...scope, prevFrom: range.prevFrom }),
      showStats: shows.list().map((show) => ({
        id: show.id,
        slug: show.slug,
        title: show.title,
        ...NO_ACCESS,
        episodesTouched: 0,
        feedFetches: 0,
        feedLastAt: null,
        ...rollups[show.id],
      })),
      busiest: services.stats.busiest(10, scope),
      failures: services.stats.recentFailures(6, scope),
      daily: services.stats.daily({ buckets: chartBuckets(range) }),
      clients,
      range,
      rangeOptions: RANGE_OPTIONS,
      kindOptions: KIND_OPTIONS,
      clientOptions: clients.map((row) => row.client),
      log: filter,
      csvHref: `/stats/access-log.csv${filter.qs ? `?${filter.qs}` : ''}`,
      entries,
      total,
      loaded: filter.offset + entries.length,
      showFilter: filter.slug,
      failuresOnly: filter.failuresOnly,
      hasMore: filter.offset + entries.length < total,
      nextOffset: filter.offset + entries.length,
    };
  }
  services.statsContext = statsContext;
  services.logPageSize = LOG_PAGE_SIZE;

  /* ---------------------------------------------------- the activity filters */

  const ACTIVITY_PAGE_SIZE = 25;

  const EVENT_OPTIONS = [
    { key: TIMELINE_EVENT.ADDED, label: 'Added' },
    { key: TIMELINE_EVENT.MISSING, label: 'Went missing' },
    { key: TIMELINE_EVENT.REMOVED, label: 'Removed' },
    { key: TIMELINE_EVENT.EXPIRED, label: 'Expired' },
  ];

  const TRIGGER_OPTIONS = [
    { value: SCAN_TRIGGER.WATCHER, label: 'File change' },
    { value: SCAN_TRIGGER.SCHEDULED, label: 'Scheduled' },
    { value: SCAN_TRIGGER.MANUAL, label: 'Rescan button' },
    { value: SCAN_TRIGGER.STARTUP, label: 'Startup' },
    { value: SCAN_TRIGGER.UPLOAD, label: 'Upload' },
  ];

  const OUTCOME_OPTIONS = [
    { key: 'problems', label: 'Problems' },
    { key: 'clean', label: 'Clean' },
  ];

  /**
   * Both cards on /activity share one URL, so the timeline owns `event` and
   * `timelineShow` while the scan log owns `showId`, `trigger` and `outcome`. Each
   * form carries the other's keys as hidden fields, so filtering one never resets
   * the other.
   */
  function activityFilter(request) {
    const query = request.query ?? {};
    const scanShow = resolveShow(query.showId);
    const timelineShow = resolveShow(query.timelineShow);
    const event = EVENT_OPTIONS.some((option) => option.key === query.event)
      ? String(query.event)
      : null;
    const trigger = TRIGGER_OPTIONS.some((option) => option.value === query.trigger)
      ? String(query.trigger)
      : null;
    const outcome = SCAN_OUTCOMES.includes(String(query.outcome)) ? String(query.outcome) : null;

    const params = {
      event,
      timelineShow: timelineShow?.slug ?? null,
      showId: scanShow?.slug ?? null,
      trigger,
      outcome,
    };

    return {
      event,
      trigger,
      outcome,
      timelineSlug: timelineShow?.slug ?? null,
      scanSlug: scanShow?.slug ?? null,
      offset: positiveInt(query.offset),
      timelineOffset: positiveInt(query.timelineOffset),
      timelineQuery: { showId: timelineShow?.id ?? null, events: event ? [event] : null },
      scanQuery: { showId: scanShow?.id ?? null, triggers: trigger ? [trigger] : null, outcome },
      params,
      qs: toQueryString(ACTIVITY_URL_KEYS, params),
      /** Everything this bar does not own, so a chip click cannot drop it. */
      carry(owned) {
        return ACTIVITY_URL_KEYS.filter((key) => !owned.includes(key) && params[key]).map((key) => [
          key,
          params[key],
        ]);
      },
    };
  }
  services.activityFilter = activityFilter;

  function activityPageUrl(filter, patch = {}) {
    const query = toQueryString(ACTIVITY_URL_KEYS, { ...filter.params, ...patch });
    return query ? `/activity?${query}` : '/activity';
  }
  services.activityPageUrl = activityPageUrl;

  function activityContext(request) {
    const filter = activityFilter(request);

    const entries = activity.list({
      ...filter.scanQuery,
      limit: ACTIVITY_PAGE_SIZE,
      offset: filter.offset,
    });
    const total = activity.count(filter.scanQuery);

    const timelineEntries = services.timeline.list({
      ...filter.timelineQuery,
      limit: ACTIVITY_PAGE_SIZE,
      offset: filter.timelineOffset,
    });
    const timelineTotal = services.timeline.count(filter.timelineQuery);

    return {
      title: 'Activity',
      active: 'activity',
      crumbs: [{ label: 'Activity' }],
      filter,
      eventOptions: EVENT_OPTIONS,
      triggerOptions: TRIGGER_OPTIONS,
      outcomeOptions: OUTCOME_OPTIONS,
      entries,
      total,
      showFilter: filter.scanSlug,
      loaded: filter.offset + entries.length,
      hasMore: filter.offset + entries.length < total,
      nextOffset: filter.offset + entries.length,
      timeline: {
        filter,
        entries: timelineEntries,
        total: timelineTotal,
        loaded: filter.timelineOffset + timelineEntries.length,
        hasMore: filter.timelineOffset + timelineEntries.length < timelineTotal,
        nextOffset: filter.timelineOffset + timelineEntries.length,
      },
    };
  }
  services.activityContext = activityContext;
  services.activityPageSize = ACTIVITY_PAGE_SIZE;

  /* -------------------------------------------------------------- settings */

  fastify.get('/settings', guarded, async (request, reply) => {
    const defaults = settings.defaults();
    return reply.view(
      'pages/settings.eta',
      shell(request, {
        title: 'Settings',
        active: 'settings',
        crumbs: [{ label: 'Settings' }],
        previousBaseUrlWindowDays: PREVIOUS_BASE_URL_WINDOW_DAYS,
        settings: {
          publicBaseUrl: settings.publicBaseUrl(),
          previousPublicBaseUrl: settings.previousPublicBaseUrl(),
          defaultAuthorName: defaults.authorName,
          defaultAuthorEmail: defaults.authorEmail,
          defaultLanguage: defaults.language,
          defaultCategory: defaults.category,
          defaultSubcategory: defaults.subcategory,
          defaultExplicit: defaults.explicit,
          rescanIntervalSeconds: settings.rescanIntervalSeconds(),
          missingGraceSeconds: settings.missingGraceSeconds(),
          watcherEnabled: settings.watcherEnabled(),
          sessionTtlHours: settings.sessionTtlHours(),
          adminUsername: settings.adminUsername(),
        },
        runtime: {
          timeZone: config.timeZone,
          dataDir: config.dataDir,
          showsDir: config.showsDir,
          puid: config.runtimeUid ?? config.puid,
          pgid: config.runtimeGid ?? config.pgid,
          maxUploadSizeMb: config.maxUploadSizeMb,
          watcher: watcher?.status() ?? null,
          scheduler: services.scheduler?.status() ?? null,
        },
      }),
      APP_LAYOUT,
    );
  });

  /**
   * Ends the forwarding period early, before the window runs out on its own.
   *
   * A plain POST and a redirect, with no htmx counterpart: it is a once-per-move
   * action whose whole visible result is that a notice on the page it returns to has
   * gone, and a fragment swap would have to re-render that notice's own container to
   * say the same thing.
   */
  fastify.post('/settings/forget-previous-base-url', guarded, async (request, reply) => {
    settings.forgetPreviousBaseUrl();
    setFlash(
      request,
      'Feeds have stopped naming the new address. Anyone still subscribed on the old one will not be moved across now.',
    );
    return reply.redirect('/settings', 303);
  });
}

function dashboardActions() {
  return `
    <button class="btn btn-ghost btn-sm" type="button"
            hx-post="/ui/rescan-all" hx-target="#scan-progress-slot" hx-swap="innerHTML">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7M21 3v6h-6"/></svg>
      Rescan all
    </button>
    <a class="btn btn-primary btn-sm" href="/shows/new"
       hx-get="/ui/modals/new-show" hx-target="#modal-root" hx-swap="innerHTML">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
      New show
    </a>`;
}

function showActions(slug) {
  const safe = encodeURIComponent(slug);
  return `
    <button class="btn btn-ghost btn-sm" type="button"
            hx-post="/ui/shows/${safe}/rescan" hx-target="#scan-progress-slot" hx-swap="innerHTML">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7M21 3v6h-6"/></svg>
      Rescan
    </button>
    <a class="btn btn-ghost btn-sm" href="/shows/${safe}/upload">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2M12 3v13M7 8l5-5 5 5"/></svg>
      Upload
    </a>`;
}

/**
 * Only same-site paths may be used as a post-login redirect target.
 *
 * Checking for a leading `//` is not enough: the URL parser treats a backslash as
 * a path separator too, so `/\\evil.example.com` resolves to another origin. The
 * value is therefore parsed and only its path and query are kept.
 */
function sanitiseNext(value) {
  if (typeof value !== 'string' || !value.startsWith('/')) return '';
  if (value.includes('\\')) return '';
  if (value.startsWith('//')) return '';
  try {
    const parsed = new URL(value, 'http://selfpod.invalid');
    if (parsed.host !== 'selfpod.invalid') return '';
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return '';
  }
}
