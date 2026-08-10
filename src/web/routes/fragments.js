import { SCAN_TRIGGER, SHOW_STATUS } from '../../constants.js';
import { notFound } from '../../lib/errors.js';
import { normaliseBaseUrl } from '../../lib/urls.js';
import { SETTING_KEYS } from '../../services/settings.js';
import { MIN_PASSWORD_LENGTH } from '../../routes/api/setup.js';
import { subscribeQrCodes } from '../lib/qr.js';
import { DEFAULT_SUBSCRIBE_TARGET } from '../lib/subscribe-links.js';

/**
 * htmx fragment endpoints.
 *
 * These share the service layer with the JSON API rather than calling it over
 * HTTP. Each one has a matching plain-form action on the same URL, so every
 * interaction works with JavaScript disabled: without htmx the handler redirects,
 * with htmx it returns the re-rendered fragment.
 */
export default async function fragmentRoutes(fastify, services) {
  const { config, settings, shows, episodes, activity, scanner, watcher, feeds, covers, presentShow, presentEpisode } = services;

  fastify.register(async (scoped) => {
    scoped.addHook('onRequest', async (request, reply) => {
      const result = await fastify.requireAdminPage(request, reply);
      if (reply.sent) return result;
      return undefined;
    });

    const isHtmx = (request) => Boolean(request.headers['hx-request']);

    function findShow(slug) {
      const show = shows.getBySlug(slug) ?? shows.get(slug);
      if (!show) throw notFound('That show does not exist.', 'show_not_found');
      return show;
    }

    /** After a non-htmx POST, go back where the user was with a flash message. */
    function redirectBack(request, reply, path, message, level = 'ok') {
      if (message) services.setFlash(request, message, level);
      return reply.redirect(path, 303);
    }

    /* ------------------------------------------------------------- show card */

    scoped.get('/ui/shows/:slug/card', async (request, reply) => {
      const show = findShow(request.params.slug);
      return reply.view('partials/show-card.eta', {
        show: presentShow(show),
        helpers: fastify.viewHelpers,
      });
    });

    scoped.get('/ui/shows/:slug/cover-box', async (request, reply) => {
      const show = findShow(request.params.slug);
      return reply.view('partials/cover-box.eta', {
        show: presentShow(show),
        helpers: fastify.viewHelpers,
      });
    });

    scoped.get('/ui/dashboard/grid', async (request, reply) => {
      const all = shows.list().map((show) => presentShow(show));
      return reply.view('partials/show-grid.eta', {
        shows: all.filter((s) => s.status === 'active'),
        showsDir: config.showsDir,
        helpers: fastify.viewHelpers,
      });
    });

    /* ---------------------------------------------------------------- shows */

    scoped.post('/ui/shows', async (request, reply) => {
      try {
        const show = await shows.create({ title: request.body?.title, slug: request.body?.slug });
        await scanner.scanShowNow(show.id, SCAN_TRIGGER.MANUAL);
        const target = `/shows/${encodeURIComponent(show.slug)}`;
        if (!isHtmx(request)) return redirectBack(request, reply, target, `“${show.title}” is ready.`);
        reply.header('HX-Redirect', target);
        return reply.send('');
      } catch (err) {
        if (!err.status || err.status >= 500) throw err;
        reply.status(err.status);
        return reply.view('partials/modal-new-show.eta', {
          title: request.body?.title,
          slug: request.body?.slug,
          errors: err.fields ?? { title: err.message },
          helpers: fastify.viewHelpers,
        });
      }
    });

    scoped.post('/ui/shows/:slug/meta', async (request, reply) => {
      const show = findShow(request.params.slug);
      const body = request.body ?? {};
      const patch = {
        title: body.title,
        description: body.description,
        authorName: body.authorName,
        authorEmail: body.authorEmail,
        language: body.language,
        category: body.category,
        subcategory: body.subcategory,
        // An unchecked checkbox is simply absent from a form post, so its absence
        // has to mean "false" rather than "leave unchanged".
        explicit: body.explicit === '1' || body.explicit === 'on' || body.explicit === true,
      };

      try {
        const updated = shows.update(show.id, patch);
        if (!isHtmx(request)) {
          return redirectBack(request, reply, `/shows/${encodeURIComponent(updated.slug)}`, 'Show updated.');
        }
        return reply.view('partials/show-meta-form.eta', {
          show: presentShow(updated),
          saved: true,
          helpers: fastify.viewHelpers,
        });
      } catch (err) {
        if (!err.fields) throw err;
        reply.status(422);
        return reply.view('partials/show-meta-form.eta', {
          // Echo what the user typed back, so a validation error never discards work.
          show: { ...presentShow(show), ...patch, explicit: patch.explicit },
          errors: err.fields,
          helpers: fastify.viewHelpers,
        });
      }
    });

    scoped.get('/ui/modals/rebuild-show/:slug', async (request, reply) => {
      const show = findShow(request.params.slug);
      return reply.view('partials/modal-rebuild-show.eta', {
        show: presentShow(show),
        helpers: fastify.viewHelpers,
      });
    });

    /**
     * Rebuilds a show's feed from disk. Both confirmations are re-checked here: the
     * gate in the browser is a convenience, and a form post can arrive without it.
     */
    scoped.post('/ui/shows/:slug/rebuild', async (request, reply) => {
      const show = findShow(request.params.slug);
      const acknowledged = request.body?.acknowledge === '1';
      const typed = String(request.body?.confirm ?? '') === show.slug;

      if (!acknowledged || !typed) {
        reply.status(422);
        return reply.view('partials/modal-rebuild-show.eta', {
          show: presentShow(show),
          errors: {
            confirm: !acknowledged
              ? 'Tick the box to confirm you understand subscribers will re-download.'
              : `Type "${show.slug}" exactly to confirm.`,
          },
          helpers: fastify.viewHelpers,
        });
      }

      if (show.status === SHOW_STATUS.FOLDER_MISSING) {
        reply.status(409);
        return reply.view('partials/modal-rebuild-show.eta', {
          show: presentShow(show),
          errors: {
            confirm: 'This show\'s folder is missing, so there is nothing on disk to rebuild from.',
          },
          helpers: fastify.viewHelpers,
        });
      }

      const forgotten = episodes.forgetAllForShow(show.id);
      await scanner.scanShowNow(show.id, SCAN_TRIGGER.MANUAL, { rehash: true });
      const after = episodes.counts(show.id);

      const entry = activity.start({
        showId: show.id,
        trigger: SCAN_TRIGGER.MANUAL,
        note: 'feed rebuilt from disk',
      });
      activity.finish(entry, {
        filesFound: after.total,
        added: after.total,
        removed: forgotten,
        note: `Rebuilt from disk at the owner's request: ${forgotten} episode${forgotten === 1 ? '' : 's'} forgotten, ${after.total} re-imported with new identities. Every subscriber re-downloads.`,
      });

      const message = `“${show.title}” was rebuilt from disk — ${after.total} episode${after.total === 1 ? '' : 's'} re-imported. Every subscriber will re-download.`;
      const path = `/shows/${encodeURIComponent(show.slug)}`;
      if (!isHtmx(request)) return redirectBack(request, reply, path, message, 'warn');
      services.setFlash(request, message, 'warn');
      reply.header('HX-Redirect', path);
      return reply.send('');
    });

    scoped.post('/ui/shows/:slug/delete', async (request, reply) => {
      const show = findShow(request.params.slug);
      const deleteFiles = request.body?.deleteFiles === '1';
      if (String(request.body?.confirm ?? '') !== show.slug) {
        reply.status(422);
        return reply.view('partials/modal-delete-show.eta', {
          show: presentShow(show),
          errors: { confirm: `Type "${show.slug}" exactly to confirm.` },
          helpers: fastify.viewHelpers,
        });
      }

      await shows.remove(show.id, { deleteFiles });
      const message = deleteFiles
        ? `“${show.title}” and its audio files were deleted.`
        : `“${show.title}” was removed from SelfPod. Its folder and audio are untouched.`;
      if (!isHtmx(request)) return redirectBack(request, reply, '/', message);
      services.setFlash(request, message);
      reply.header('HX-Redirect', '/');
      return reply.send('');
    });

    scoped.post('/ui/shows/:slug/rotate-token', async (request, reply) => {
      const show = findShow(request.params.slug);
      const updated = shows.rotateToken(show.id);
      feeds.invalidate(show.id);
      const presented = presentShow(updated);

      if (!isHtmx(request)) {
        return redirectBack(
          request,
          reply,
          `/shows/${encodeURIComponent(updated.slug)}`,
          'The feed token was rotated. Re-add the show in your podcast app using the new URL.',
        );
      }

      // Replace the modal with the refreshed feed box, so the new URL and its QR
      // code appear in place.
      reply.header('HX-Retarget', '#feed-box');
      reply.header('HX-Reswap', 'outerHTML');
      return reply.view('partials/feed-box.eta', {
        show: presented,
        subscribeCodes: await subscribeQrCodes(presented.feedUrl),
        defaultSubscribeTarget: DEFAULT_SUBSCRIBE_TARGET,
        helpers: fastify.viewHelpers,
      });
    });

    scoped.post('/ui/shows/:slug/cover/normalize', async (request, reply) => {
      const show = findShow(request.params.slug);
      if (!show.cover_filename) throw notFound('This show has no cover art yet.', 'no_cover');

      const result = await covers.normalise(shows.dirFor(show), show.cover_filename);
      shows.setSystemFields(show.id, {
        cover_filename: result.filename,
        cover_width: result.after.width,
        cover_height: result.after.height,
        cover_format: result.after.format,
        cover_mtime: result.after.mtime,
      });
      feeds.invalidate(show.id);

      if (!isHtmx(request)) {
        return redirectBack(
          request,
          reply,
          `/shows/${encodeURIComponent(show.slug)}`,
          `Cover art resized to ${result.after.width}×${result.after.height}.`,
        );
      }
      return reply.view('partials/cover-box.eta', {
        show: presentShow(shows.get(show.id)),
        helpers: fastify.viewHelpers,
      });
    });

    /* ------------------------------------------------------------- episodes */

    scoped.post('/ui/episodes/:id', async (request, reply) => {
      const episode = episodes.get(request.params.id);
      if (!episode) throw notFound('That episode does not exist.', 'episode_not_found');
      const show = shows.get(episode.show_id);
      const body = request.body ?? {};

      try {
        const updated = episodes.update(
          episode.id,
          {
            title: body.title,
            description: body.description,
            season: body.season,
            episodeNumber: body.episodeNumber,
            pubDate: body.pubDate,
            explicit: body.explicit,
          },
          { timeZone: config.timeZone },
        );
        if (!isHtmx(request)) {
          return redirectBack(
            request,
            reply,
            `/shows/${encodeURIComponent(show.slug)}/episodes/${encodeURIComponent(episode.id)}`,
            'Episode updated.',
          );
        }
        return reply.view('partials/episode-form.eta', {
          episode: presentEpisode(updated, show),
          show: presentShow(show),
          saved: true,
          helpers: fastify.viewHelpers,
        });
      } catch (err) {
        if (!err.fields) throw err;
        reply.status(422);
        return reply.view('partials/episode-form.eta', {
          episode: { ...presentEpisode(episode, show), ...body },
          show: presentShow(show),
          errors: err.fields,
          helpers: fastify.viewHelpers,
        });
      }
    });

    scoped.post('/ui/episodes/:id/remove', async (request, reply) => {
      const episode = episodes.get(request.params.id);
      if (!episode) throw notFound('That episode does not exist.', 'episode_not_found');
      const show = shows.get(episode.show_id);
      episodes.removeFromFeed(episode.id);

      const message = 'Removed from the feed. The audio file is untouched, and rescans will leave it out.';
      if (!isHtmx(request)) {
        return redirectBack(request, reply, `/shows/${encodeURIComponent(show.slug)}`, message);
      }
      return renderEpisodeTableWithToast(reply, show, message);
    });

    scoped.post('/ui/episodes/:id/restore', async (request, reply) => {
      const episode = episodes.get(request.params.id);
      if (!episode) throw notFound('That episode does not exist.', 'episode_not_found');
      const show = shows.get(episode.show_id);
      episodes.restoreToFeed(episode.id);

      const message = 'Back in the feed.';
      if (!isHtmx(request)) {
        return redirectBack(request, reply, `/shows/${encodeURIComponent(show.slug)}`, message);
      }
      return renderEpisodeTableWithToast(reply, show, message);
    });

    scoped.post('/ui/episodes/:id/delete-file', async (request, reply) => {
      const episode = episodes.get(request.params.id);
      if (!episode) throw notFound('That episode does not exist.', 'episode_not_found');
      const show = shows.get(episode.show_id);

      if (request.body?.confirm !== '1') {
        reply.status(422);
        return reply.view('partials/modal-delete-episode.eta', {
          episode: presentEpisode(episode, show),
          show: presentShow(show),
          helpers: fastify.viewHelpers,
        });
      }

      const result = await episodes.deleteWithFile(episode.id);
      const message = `Deleted ${result.filename} from disk.`;
      if (!isHtmx(request)) {
        return redirectBack(request, reply, `/shows/${encodeURIComponent(show.slug)}`, message, 'warn');
      }
      return renderEpisodeTableWithToast(reply, show, message, 'warn');
    });

    /**
     * The modal lives in #modal-root, but the useful update is the episode table.
     * Retargeting keeps a single response doing both: swap the table, and let the
     * out-of-band toast clear the modal.
     */
    async function renderEpisodeTableWithToast(reply, show, message, level = 'ok') {
      reply.header('HX-Retarget', '#episode-table');
      reply.header('HX-Reswap', 'outerHTML');
      reply.header('HX-Trigger', 'selfpod:modal-close');
      const rendered = await reply.view('partials/episode-table.eta', {
        show: presentShow(show),
        episodes: episodes.listByShow(show.id).map((e) => presentEpisode(e, show)),
        helpers: fastify.viewHelpers,
      });
      void level;
      void message;
      return rendered;
    }

    /* ---------------------------------------------------------------- scans */

    scoped.post('/ui/rescan-all', async (request, reply) => {
      // Kick the scan off and answer immediately: the progress strip is driven by
      // SSE, and a six-show library must not block the response.
      scanner.enqueueAll(SCAN_TRIGGER.MANUAL);
      if (!isHtmx(request)) return redirectBack(request, reply, request.headers.referer ?? '/', 'Rescanning…');
      return reply.view('partials/scan-progress.eta', { scope: 'all', label: 'Scanning your whole library…' });
    });

    scoped.post('/ui/shows/:slug/rescan', async (request, reply) => {
      const show = findShow(request.params.slug);
      scanner.enqueueShow(show.id, SCAN_TRIGGER.MANUAL, { rehash: true });
      if (!isHtmx(request)) {
        return redirectBack(request, reply, `/shows/${encodeURIComponent(show.slug)}`, 'Rescanning…');
      }
      return reply.view('partials/scan-progress.eta', {
        scope: show.id,
        label: `Rescanning ${show.title}…`,
      });
    });

    /**
     * The polling backstop for the progress strip. Returns the strip while a scan
     * is still running and nothing once it is done, so the strip always clears
     * even if no SSE event ever arrives.
     */
    scoped.get('/ui/scan-status', async (request, reply) => {
      if (!scanner.isScanning) return reply.type('text/html; charset=utf-8').send('');
      const current = scanner.current;
      const scope = String(request.query?.scope ?? 'all');
      return reply.view('partials/scan-progress.eta', {
        scope,
        label: current?.title ? `Scanning ${current.title}…` : 'Scanning…',
      });
    });

    /* ------------------------------------------------------------- activity */

    scoped.get('/ui/activity', async (request, reply) => {
      const showFilter = request.query?.showId ? String(request.query.showId) : null;
      const filtered = showFilter ? shows.getBySlug(showFilter) ?? shows.get(showFilter) : null;
      const offset = Number.parseInt(String(request.query?.offset ?? '0'), 10) || 0;
      const limit = 25;
      const entries = activity.list({ showId: filtered?.id ?? null, limit, offset });
      const total = activity.count({ showId: filtered?.id ?? null });

      return reply.view('partials/activity-list.eta', {
        entries,
        total,
        showFilter: filtered?.slug ?? null,
        hasMore: offset + entries.length < total,
        nextOffset: offset + entries.length,
        helpers: fastify.viewHelpers,
      });
    });

    /* ----------------------------------------------------------- statistics */

    scoped.get('/ui/stats/log', async (request, reply) => {
      const filter = services.logFilter(request);
      const limit = services.logPageSize;
      const entries = services.stats.list({ ...filter.query, limit, offset: filter.offset });
      const total = services.stats.count(filter.query);

      return reply.view('partials/access-log.eta', {
        entries,
        total,
        showFilter: filter.slug,
        failuresOnly: filter.query.failuresOnly,
        hasMore: filter.offset + entries.length < total,
        nextOffset: filter.offset + entries.length,
        helpers: fastify.viewHelpers,
      });
    });

    /* ------------------------------------------------------------- settings */

    const SETTING_ROWS = {
      publicBaseUrl: {
        title: 'Public base URL',
        description: 'Include the scheme, no trailing slash — for example https://podcast.example.com',
        mono: true,
        placeholder: 'https://podcast.example.com',
        read: () => settings.publicBaseUrl(),
        display: () => settings.publicBaseUrl() || 'Not set',
        write(value) {
          const normalised = normaliseBaseUrl(String(value ?? ''));
          if (!normalised) {
            return { error: 'Include the scheme and host, for example https://podcast.example.com' };
          }
          return { patch: { [SETTING_KEYS.PUBLIC_BASE_URL]: normalised } };
        },
      },
      rescanIntervalSeconds: {
        title: 'Fallback rescan interval',
        description:
          'This is what guarantees correctness on network shares, where file-change events are often never delivered. Between 1 minute and 6 hours.',
        hint: 'Enter seconds, or use "5m" / "2h".',
        read: () => settings.rescanIntervalSeconds(),
        display: () => fastify.viewHelpers.formatInterval(settings.rescanIntervalSeconds()),
        write(value) {
          const seconds = parseSeconds(value);
          if (seconds === null || seconds < 60 || seconds > 6 * 60 * 60) {
            return { error: 'Choose between 1 minute and 6 hours.' };
          }
          return { patch: { [SETTING_KEYS.RESCAN_INTERVAL_SECONDS]: String(seconds) } };
        },
      },
      missingGraceSeconds: {
        title: 'Missing-file grace period',
        description:
          'How long an episode stays in the feed after its file disappears, so a brief share outage does not drop episodes from subscribers.',
        hint: 'Enter seconds, or use "24h".',
        read: () => settings.missingGraceSeconds(),
        display: () => fastify.viewHelpers.formatInterval(settings.missingGraceSeconds()),
        write(value) {
          const seconds = parseSeconds(value);
          if (seconds === null || seconds < 60 || seconds > 30 * 24 * 60 * 60) {
            return { error: 'Choose between 1 minute and 30 days.' };
          }
          return { patch: { [SETTING_KEYS.MISSING_GRACE_SECONDS]: String(seconds) } };
        },
      },
      defaultAuthorName: {
        title: 'Default author name',
        read: () => settings.defaults().authorName,
        display: () => settings.defaults().authorName || 'Not set',
        write: (value) => ({
          patch: { [SETTING_KEYS.DEFAULT_AUTHOR_NAME]: String(value ?? '').trim().slice(0, 200) },
        }),
      },
      defaultAuthorEmail: {
        title: 'Default author email',
        description: 'Podcast directories require an owner email to verify who owns a show.',
        mono: true,
        inputType: 'email',
        read: () => settings.defaults().authorEmail,
        display: () => settings.defaults().authorEmail || 'Not set',
        write(value) {
          const email = String(value ?? '').trim();
          if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return { error: "That doesn't look like an email address." };
          }
          return { patch: { [SETTING_KEYS.DEFAULT_AUTHOR_EMAIL]: email.slice(0, 200) } };
        },
      },
      defaultLanguage: {
        title: 'Default language',
        mono: true,
        last: true,
        read: () => settings.defaults().language,
        display: () => settings.defaults().language,
        write(value) {
          const language = String(value ?? '').trim().toLowerCase();
          if (!/^[a-z]{2}(-[a-z]{2})?$/.test(language)) {
            return { error: 'Use a language code like "en" or "en-gb".' };
          }
          return { patch: { [SETTING_KEYS.DEFAULT_LANGUAGE]: language } };
        },
      },
      sessionTtlHours: {
        title: 'Stay signed in for',
        description:
          'Session cookies are HttpOnly, SameSite=Lax, and marked Secure automatically when SelfPod is reached over HTTPS.',
        hint: 'Hours.',
        read: () => settings.sessionTtlHours(),
        display: () => `${settings.sessionTtlHours()} hours`,
        write(value) {
          const hours = Number.parseInt(String(value), 10);
          if (!Number.isFinite(hours) || hours < 1 || hours > 24 * 30) {
            return { error: 'Choose between 1 hour and 30 days.' };
          }
          return { patch: { [SETTING_KEYS.SESSION_TTL_HOURS]: String(hours) } };
        },
      },
    };

    function renderSettingRow(reply, key, { editing = false, errors = null } = {}) {
      const row = SETTING_ROWS[key];
      return reply.view('partials/settings-row.eta', {
        key,
        title: row.title,
        description: row.description,
        hint: editing ? row.hint : null,
        mono: row.mono,
        last: row.last,
        inputType: row.inputType,
        placeholder: row.placeholder,
        value: row.display(),
        rawValue: row.read(),
        editing,
        errors,
        helpers: fastify.viewHelpers,
      });
    }

    scoped.get('/ui/settings/:key', async (request, reply) => {
      const key = request.params.key;
      if (!SETTING_ROWS[key]) throw notFound('Unknown setting.', 'unknown_setting');
      return renderSettingRow(reply, key, { editing: request.query?.edit === '1' });
    });

    scoped.post('/ui/settings/:key', async (request, reply) => {
      const key = request.params.key;
      const row = SETTING_ROWS[key];
      if (!row) throw notFound('Unknown setting.', 'unknown_setting');

      const result = row.write(request.body?.value);
      if (result.error) {
        reply.status(422);
        return renderSettingRow(reply, key, { editing: true, errors: { [key]: result.error } });
      }

      const changed = settings.update(result.patch);
      if (changed.includes(SETTING_KEYS.RESCAN_INTERVAL_SECONDS)) await watcher?.restart();
      if (
        changed.includes(SETTING_KEYS.DEFAULT_AUTHOR_NAME) ||
        changed.includes(SETTING_KEYS.DEFAULT_AUTHOR_EMAIL)
      ) {
        shows.applyDefaultsToBlankShows();
      }

      if (!isHtmx(request)) return redirectBack(request, reply, '/settings', `${row.title} updated.`);
      return renderSettingRow(reply, key, { editing: false });
    });

    scoped.post('/ui/settings/watcher', async (request, reply) => {
      const enabled = request.body?.watcherEnabled === '1' || request.body?.watcherEnabled === 'on';
      settings.update({ [SETTING_KEYS.WATCHER_ENABLED]: enabled ? '1' : '0' });
      await watcher?.restart();

      if (!isHtmx(request)) {
        return redirectBack(
          request,
          reply,
          '/settings',
          enabled ? 'Live file detection switched on.' : 'Live file detection switched off.',
        );
      }
      // Re-render the whole settings page section by asking the browser to reload
      // it: the watcher's mode label depends on state this fragment doesn't own.
      reply.header('HX-Refresh', 'true');
      return reply.send('');
    });

    scoped.post('/ui/settings/dismiss-watcher-notice', async (request, reply) => {
      settings.update({ [SETTING_KEYS.WATCHER_NOTICE_DISMISSED]: '1' });
      return reply.send('');
    });

    scoped.post('/ui/settings/password', async (request, reply) => {
      const bcrypt = (await import('bcryptjs')).default;
      const { currentPassword, password, passwordConfirm } = request.body ?? {};
      const errors = {};

      const hash = settings.adminPasswordHash();
      if (!(await bcrypt.compare(String(currentPassword ?? ''), hash ?? ''))) {
        errors.currentPassword = 'That is not your current password.';
      }
      if (String(password ?? '').length < MIN_PASSWORD_LENGTH) {
        errors.password = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
      } else if (password !== passwordConfirm) {
        errors.passwordConfirm = "Those two passwords don't match.";
      }

      if (Object.keys(errors).length) {
        reply.status(422);
        return reply.view('partials/modal-change-password.eta', { errors, helpers: fastify.viewHelpers });
      }

      await fastify.setAdminPassword(password);
      if (!isHtmx(request)) return redirectBack(request, reply, '/settings', 'Password changed.');
      return reply.view('partials/modal-closed.eta', {
        toast: { message: 'Password changed.', level: 'ok' },
      });
    });

    /* --------------------------------------------------------------- modals */

    scoped.get('/ui/modals/new-show', async (request, reply) =>
      reply.view('partials/modal-new-show.eta', { helpers: fastify.viewHelpers }),
    );

    scoped.get('/ui/modals/change-password', async (request, reply) =>
      reply.view('partials/modal-change-password.eta', { helpers: fastify.viewHelpers }),
    );

    scoped.get('/ui/modals/delete-show/:slug', async (request, reply) => {
      const show = findShow(request.params.slug);
      return reply.view('partials/modal-delete-show.eta', {
        show: presentShow(show),
        helpers: fastify.viewHelpers,
      });
    });

    scoped.get('/ui/modals/rotate-token/:slug', async (request, reply) => {
      const show = findShow(request.params.slug);
      return reply.view('partials/modal-rotate-token.eta', {
        show: presentShow(show),
        helpers: fastify.viewHelpers,
      });
    });

    scoped.get('/ui/modals/delete-episode/:id', async (request, reply) => {
      const episode = episodes.get(request.params.id);
      if (!episode) throw notFound('That episode does not exist.', 'episode_not_found');
      const show = shows.get(episode.show_id);
      return reply.view('partials/modal-delete-episode.eta', {
        episode: presentEpisode(episode, show),
        show: presentShow(show),
        helpers: fastify.viewHelpers,
      });
    });
  });
}

function parseSeconds(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  const match = raw.match(/^(\d+)\s*(s|sec|secs|m|min|mins|h|hr|hrs)?$/);
  if (!match) return null;
  const amount = Number.parseInt(match[1], 10);
  if (!Number.isFinite(amount)) return null;
  const unit = match[2] ?? 's';
  if (unit.startsWith('m')) return amount * 60;
  if (unit.startsWith('h')) return amount * 3600;
  return amount;
}
