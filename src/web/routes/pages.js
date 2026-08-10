import { SHOW_STATUS } from '../../constants.js';
import { notFound } from '../../lib/errors.js';
import { normaliseBaseUrl } from '../../lib/urls.js';
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
    const watcherStatus = watcher?.status();
    const notice =
      watcherStatus?.degraded && !settings.watcherNoticeDismissed()
        ? health.get('watcher')?.message ?? null
        : null;

    return reply.view(
      'pages/dashboard.eta',
      shell(request, {
        title: 'Dashboard',
        crumbs: [{ label: 'Dashboard' }],
        shows: all.filter((s) => s.status === SHOW_STATUS.ACTIVE),
        pausedShows: all.filter((s) => s.status === SHOW_STATUS.FOLDER_MISSING),
        lastScan: activity.latestGlobal(),
        watcherNotice: notice,
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
    const presented = presentShow(show, { includeEpisodes: true });

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

  fastify.get('/activity', guarded, async (request, reply) => {
    const showFilter = request.query?.showId ? String(request.query.showId) : null;
    const filtered = showFilter ? shows.getBySlug(showFilter) ?? shows.get(showFilter) : null;
    const limit = 25;
    const entries = activity.list({ showId: filtered?.id ?? null, limit, offset: 0 });
    const total = activity.count({ showId: filtered?.id ?? null });

    return reply.view(
      'pages/activity.eta',
      shell(request, {
        title: 'Activity',
        active: 'activity',
        crumbs: [{ label: 'Activity' }],
        entries,
        total,
        showFilter: filtered?.slug ?? null,
        hasMore: entries.length < total,
        nextOffset: entries.length,
      }),
      APP_LAYOUT,
    );
  });

  /* ----------------------------------------------------------- statistics */

  /**
   * Downloads, streams and — the reason this page earns its place in the nav —
   * every request that failed. An episode that will not download in a podcast app
   * was previously invisible to SelfPod; now it is a row here with a reason.
   */
  fastify.get('/stats', guarded, async (request, reply) =>
    reply.view('pages/stats.eta', shell(request, statsContext(request)), APP_LAYOUT),
  );

  const LOG_PAGE_SIZE = 40;

  function statsContext(request) {
    const filter = logFilter(request);
    const entries = services.stats.list({ ...filter.query, limit: LOG_PAGE_SIZE, offset: filter.offset });
    const total = services.stats.count(filter.query);

    return {
      title: 'Statistics',
      active: 'stats',
      crumbs: [{ label: 'Statistics' }],
      overview: services.stats.overview(),
      showStats: shows.list().map((show) => ({
        id: show.id,
        slug: show.slug,
        title: show.title,
        ...services.stats.forShow(show.id),
      })),
      busiest: services.stats.busiest(10),
      failures: services.stats.recentFailures(6),
      entries,
      total,
      showFilter: filter.slug,
      failuresOnly: filter.query.failuresOnly,
      hasMore: filter.offset + entries.length < total,
      nextOffset: filter.offset + entries.length,
    };
  }
  services.statsContext = statsContext;
  services.logPageSize = LOG_PAGE_SIZE;

  /** Shared by the page and its htmx fragment so both filter identically. */
  function logFilter(request) {
    const query = request.query ?? {};
    const slug = query.showId ? String(query.showId) : null;
    const show = slug ? (shows.getBySlug(slug) ?? shows.get(slug)) : null;
    const offset = Number.parseInt(query.offset ?? '0', 10);
    return {
      slug: show?.slug ?? null,
      offset: Number.isFinite(offset) && offset > 0 ? offset : 0,
      query: {
        showId: show?.id ?? null,
        failuresOnly: query.failuresOnly === '1' || query.failuresOnly === 'true' || query.failuresOnly === 'on',
      },
    };
  }
  services.logFilter = logFilter;

  /* -------------------------------------------------------------- settings */

  fastify.get('/settings', guarded, async (request, reply) => {
    const defaults = settings.defaults();
    return reply.view(
      'pages/settings.eta',
      shell(request, {
        title: 'Settings',
        active: 'settings',
        crumbs: [{ label: 'Settings' }],
        settings: {
          publicBaseUrl: settings.publicBaseUrl(),
          defaultAuthorName: defaults.authorName,
          defaultAuthorEmail: defaults.authorEmail,
          defaultLanguage: defaults.language,
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
