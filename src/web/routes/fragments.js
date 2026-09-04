import {
  AD_TRIM_MODES,
  ITEM_DECISION,
  REMOTE_MAX_ITEMS_PER_POLL,
  SCAN_TRIGGER,
  SEGMENT_STATUS,
  SHOW_STATUS,
} from '../../constants.js';
import { notFound } from '../../lib/errors.js';
import { normaliseKeywords } from '../../lib/feed-filter.js';
import { SEGMENT_STATUS as STATUS } from '../../constants.js';
import { presentItem, presentSubscription } from '../../lib/present-subscription.js';
import { normaliseBaseUrl } from '../../lib/urls.js';
import { SETTING_KEYS } from '../../services/settings.js';
import { isValidCategory, isValidSubcategory } from '../lib/apple-categories.js';
import { DECIDE_LIMIT, DETECT_LIMIT } from '../../routes/api/ad-segments.js';
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

    /* ----------------------------------------------------------- ad segments */

    function advertsPath(slug) {
      return `/shows/${encodeURIComponent(slug)}/adverts`;
    }

    /** The one place the review panel is rendered, so htmx and a reload agree. */
    async function renderSegments(reply, show, extra = {}) {
      return reply.view('partials/ad-segments.eta', {
        show: presentShow(show),
        ...(await services.advertsView.segmentsContext(show)),
        helpers: fastify.viewHelpers,
        ...extra,
      });
    }

    /** The episode page's "What SelfPod heard" card, for the routes that re-render it. */
    async function renderTranscript(reply, episode, show) {
      return reply.view('partials/episode-transcript.eta', {
        show: presentShow(show),
        episode: presentEpisode(episode, show),
        transcript: await services.advertsView.episodeTranscript(episode, show),
        helpers: fastify.viewHelpers,
      });
    }

    /** Where a decision came from, so the reply re-renders the panel it was made on. */
    function returnTarget(request, show) {
      const target = String(request.body?.returnTo ?? '');
      if (target.startsWith('episode:')) {
        const episode = episodes.get(target.slice('episode:'.length));
        if (episode && episode.show_id === show.id) return { episode };
      }
      return null;
    }

    scoped.get('/ui/shows/:slug/ad-segments', async (request, reply) => renderSegments(reply, findShow(request.params.slug)));

    scoped.get('/ui/shows/:slug/transcribe-status', async (request, reply) => {
      const show = findShow(request.params.slug);
      const status = services.transcriber?.status?.() ?? { active: null };
      if (!status.active || status.active.showId !== show.id) return reply.type('text/html; charset=utf-8').send('');
      const progress = services.transcriber.progress(show.id);
      return reply.view('partials/transcribe-progress.eta', {
        showId: show.id,
        slug: show.slug,
        label: `Listened to ${progress.done} of ${progress.total}, newest first — hearing “${status.active.title ?? 'an episode'}”…`,
      });
    });

    scoped.post('/ui/shows/:slug/ad-trim', async (request, reply) => {
      const show = findShow(request.params.slug);
      const body = request.body ?? {};
      const mode = AD_TRIM_MODES.includes(body.mode) ? body.mode : show.ad_trim_mode ?? 'off';
      const parsed = Number(body.minEpisodes);
      const minEpisodes =
        Number.isInteger(parsed) && parsed >= 2 && parsed <= 20
          ? parsed
          : (show.ad_auto_min_episodes ?? 3);

      const listen = services.advertsView.listenSettingsFrom(body, show);
      if (listen.error) {
        if (!isHtmx(request)) return redirectBack(request, reply, advertsPath(show.slug), listen.error, 'err');
        reply.status(422);
        return renderSegments(reply, show, { formError: listen.error });
      }
      const listenChanged =
        listen.fields.ad_transcribe !== show.ad_transcribe ||
        listen.fields.ad_transcribe_head_seconds !== show.ad_transcribe_head_seconds ||
        listen.fields.ad_transcribe_tail_seconds !== show.ad_transcribe_tail_seconds;

      services.db
        .prepare(
          `UPDATE shows SET ad_trim_mode = ?, ad_auto_min_episodes = ?, ad_transcribe = ?, ad_transcribe_head_seconds = ?,
                  ad_transcribe_tail_seconds = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          mode, minEpisodes, listen.fields.ad_transcribe, listen.fields.ad_transcribe_head_seconds,
          listen.fields.ad_transcribe_tail_seconds, new Date().toISOString(), show.id,
        );
      // New windows mean new transcripts; the old ones are forgotten so the next run
      // makes them, rather than comparing words nobody asked for any more.
      if (listenChanged) services.transcriber?.forgetShow(show.id);

      // Settled in the same request. Switching a show off has to actually let its
      // episodes out, and waiting for a scheduler tick to find out whether it worked
      // is how someone concludes it did not.
      const settled = services.adPipeline.settle(show.id);
      const updated = shows.get(show.id);

      if (!isHtmx(request)) {
        const note = settled.released
          ? `Saved. ${settled.released} ${settled.released === 1 ? 'episode is' : 'episodes are'} now in your feed.`
          : 'Saved.';
        return redirectBack(request, reply, advertsPath(show.slug), note);
      }
      return renderSegments(reply, updated);
    });

    // The same caps as the JSON routes, and for the same reason: these run the
    // identical work. A limit on one URL and not the other is not a limit.
    scoped.post('/ui/shows/:slug/ad-detect', { preHandler: [fastify.rateLimit(DETECT_LIMIT)] }, async (request, reply) => {
      const show = findShow(request.params.slug);
      if (!show.ad_trim_mode || show.ad_trim_mode === 'off') {
        return isHtmx(request)
          ? renderSegments(reply, show)
          : redirectBack(request, reply, advertsPath(show.slug), 'Advert detection is off for this show.', 'err');
      }
      await services.adPipeline.processShow(show.id);
      if (!isHtmx(request)) {
        return redirectBack(request, reply, advertsPath(show.slug), 'Checked.');
      }
      return renderSegments(reply, shows.get(show.id));
    });

    scoped.post('/ui/shows/:slug/ad-segments/:segmentId', { preHandler: [fastify.rateLimit(DECIDE_LIMIT)] }, async (request, reply) => {
      const show = findShow(request.params.slug);
      const status = request.body?.status;
      if (status !== SEGMENT_STATUS.APPROVED && status !== SEGMENT_STATUS.REJECTED) {
        return isHtmx(request)
          ? renderSegments(reply, show)
          : redirectBack(request, reply, advertsPath(show.slug), 'A segment is either removed or kept.', 'err');
      }

      const segment = services.adDetect.getSegment(request.params.segmentId);
      if (!segment || segment.show_id !== show.id) {
        throw notFound('That segment no longer exists.', 'segment_not_found');
      }
      const back = returnTarget(request, show);

      /*
       * Edges moved by word. The words are the segment, so moving them rewrites what
       * every later episode is matched against, and the run below re-finds the new
       * words everywhere else.
       */
      const body = request.body ?? {};
      if (body.startWord !== undefined && body.endWord !== undefined && body.episodeId) {
        const episode = episodes.get(String(body.episodeId));
        if (!episode || episode.show_id !== show.id) throw notFound('That episode no longer exists.', 'episode_not_found');
        const range = await services.advertsView.wordRange(episode, body.startWord, body.endWord);
        if (!range) {
          const message = 'The last word has to come after the first.';
          if (!isHtmx(request)) return redirectBack(request, reply, advertsPath(show.slug), message, 'err');
          reply.status(422);
          return renderSegments(reply, show, { formError: message });
        }
        await services.adDetect.reshapeSegment(segment.id, { episodeId: episode.id, ...range });
      }

      if (status === 'programme_starts') {
        // "The programme starts here", from a card: the words become a boundary and
        // the intro they belong to is kept.
        services.adDetect.addMarker({ showId: show.id, role: 'programme_starts', rawText: segment.raw_text ?? '', language: segment.language });
        services.adDetect.decide(segment.id, STATUS.REJECTED);
      } else {
        services.adDetect.decide(segment.id, status);
      }
      // The cut happens here rather than on the next tick, because a decision that has
      // not reached the audio has not really been taken.
      const result = await services.adPipeline.processShow(show.id);

      if (!isHtmx(request)) {
        const note =
          status === SEGMENT_STATUS.APPROVED
            ? `Removed from ${result.trimmed?.trimmed ?? 0} ${(result.trimmed?.trimmed ?? 0) === 1 ? 'episode' : 'episodes'}.`
            : status === 'programme_starts'
              ? `From now on everything before “${segment.raw_text}” is cut, in every episode where SelfPod hears it.`
              : 'Kept.';
        return redirectBack(request, reply, back ? episodePath(show.slug, back.episode.id) : advertsPath(show.slug), note);
      }
      if (back) return renderTranscript(reply, episodes.get(back.episode.id), shows.get(show.id));
      return renderSegments(reply, shows.get(show.id));
    });

    function episodePath(slug, id) {
      return `/shows/${encodeURIComponent(slug)}/episodes/${encodeURIComponent(id)}`;
    }

    /** Forgetting a boundary puts back everything it cut. */
    scoped.post('/ui/shows/:slug/ad-markers/:markerId/remove', { preHandler: [fastify.rateLimit(DECIDE_LIMIT)] }, async (request, reply) => {
      const show = findShow(request.params.slug);
      const marker = services.adDetect.getMarker(request.params.markerId);
      if (!marker || marker.show_id !== show.id) throw notFound('That boundary no longer exists.', 'marker_not_found');
      const back = returnTarget(request, show);
      services.adDetect.removeMarker(marker.id);
      await services.adPipeline.processShow(show.id);
      if (!isHtmx(request)) {
        return redirectBack(request, reply, back ? episodePath(show.slug, back.episode.id) : advertsPath(show.slug), 'Forgotten, and the audio put back.');
      }
      if (back) return renderTranscript(reply, episodes.get(back.episode.id), shows.get(show.id));
      return renderSegments(reply, shows.get(show.id));
    });

    /* ------------------------------------------------------------ transcripts */

    function findEpisode(id) {
      const episode = episodes.get(id);
      if (!episode) throw notFound('That episode does not exist.', 'episode_not_found');
      return { episode, show: shows.getOrThrow(episode.show_id) };
    }

    scoped.get('/ui/episodes/:id/transcript', async (request, reply) => {
      const { episode, show } = findEpisode(request.params.id);
      return renderTranscript(reply, episode, show);
    });

    /**
     * The teaching loop: a range of words and what they are. An advert becomes a
     * remembered read with the decision already taken; a boundary becomes a marker.
     * Either way the run happens now, so the owner sees the cut land.
     */
    scoped.post('/ui/episodes/:id/transcript/teach', { preHandler: [fastify.rateLimit(DECIDE_LIMIT)] }, async (request, reply) => {
      const { episode, show } = findEpisode(request.params.id);
      const body = request.body ?? {};
      const verdict = String(body.verdict ?? '');
      const range = await services.advertsView.wordRange(episode, body.startWord, body.endWord);
      const fail = (message) => {
        if (!isHtmx(request)) return redirectBack(request, reply, episodePath(show.slug, episode.id), message, 'err');
        reply.status(422);
        return renderTranscript(reply, episode, show);
      };
      if (!range) return fail('Pick a first and a last word, in that order.');

      let note;
      if (verdict === 'advert' || verdict === 'not_advert') {
        await services.adDetect.teachSegment({
          showId: show.id,
          episodeId: episode.id,
          ...range,
          status: verdict === 'advert' ? STATUS.APPROVED : STATUS.REJECTED,
        });
        note =
          verdict === 'advert'
            ? `Removed ${fastify.viewHelpers.formatDuration(Math.round(range.startMs / 1000))}–${fastify.viewHelpers.formatDuration(Math.round(range.endMs / 1000))} from this episode. The same words will be cut from later episodes.`
            : 'Kept, and SelfPod will not offer those words again.';
      } else if (verdict === 'programme_starts' || verdict === 'programme_ends') {
        services.adDetect.addMarker({ showId: show.id, role: verdict, rawText: range.rawText, language: range.language });
        note =
          verdict === 'programme_starts'
            ? `From now on everything before “${range.rawText}” is cut, in every episode where SelfPod hears it.`
            : `From now on everything after “${range.rawText}” is cut, in every episode where SelfPod hears it.`;
      } else {
        return fail('Say what those words are.');
      }
      await services.adPipeline.processShow(show.id);
      if (!isHtmx(request)) return redirectBack(request, reply, episodePath(show.slug, episode.id), note);
      return renderTranscript(reply, episodes.get(episode.id), shows.get(show.id));
    });

    /* ---------------------------------------------------------- subscription */

    /**
     * Minutes in, seconds out.
     *
     * Nobody thinks about episode length in seconds. Asking them to is how a
     * twenty-minute minimum gets typed as "20" and silently becomes twenty seconds —
     * a filter that then matches everything, with nothing to say why.
     */
    function minutesToSeconds(value) {
      const raw = String(value ?? '').trim();
      if (!raw) return null;
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) return raw; // let the service reject it, with wording
      return Math.round(parsed * 60);
    }

    function subscriptionPath(slug) {
      return `/shows/${encodeURIComponent(slug)}/subscription`;
    }

    function renderForm(reply, { show, subscription, errors, values, saved, reopened }) {
      return reply.view('partials/subscription-form.eta', {
        show: presentShow(show),
        subscription: subscription ? presentSubscription(subscription, services) : null,
        errors,
        values,
        saved,
        reopened,
        helpers: fastify.viewHelpers,
      });
    }

    /**
     * The ledger card, filtered by whatever the request carries.
     *
     * The filter travels in the query string even on the redownload POST, so that
     * fetching one episode by hand re-renders the view the operator was looking at
     * rather than throwing them back to the unfiltered first page.
     */
    function renderItems(reply, subscription, request) {
      return reply.view('partials/subscription-items.eta', services.ledgerContext(subscription, request));
    }

    /** Create or update, on one URL, because the form is the same either way. */
    scoped.post('/ui/shows/:slug/subscription', async (request, reply) => {
      const show = findShow(request.params.slug);
      const body = request.body ?? {};
      const patch = {
        feedUrl: body.feedUrl,
        includeKeywords: body.includeKeywords,
        excludeKeywords: body.excludeKeywords,
        minDurationSeconds: minutesToSeconds(body.minDurationMinutes),
        maxDurationSeconds: minutesToSeconds(body.maxDurationMinutes),
        backfillCount: body.backfillCount,
      };
      const existing = services.subscriptions.getForShow(show.id);

      try {
        let reopened = 0;
        let subscription;
        if (existing) {
          reopened = services.subscriptions.reopenableCount(existing.id);
          subscription = services.subscriptions.update(existing.id, patch);
        } else {
          subscription = services.subscriptions.create(show.id, patch);
        }
        if (!isHtmx(request)) {
          return redirectBack(request, reply, subscriptionPath(show.slug), 'Saved.');
        }
        return renderForm(reply, { show, subscription, saved: true, reopened });
      } catch (error) {
        if (!error.fields) throw error;
        // Re-render with the user's own input echoed back, so a rejected form is not
        // an empty form.
        if (!isHtmx(request)) {
          return redirectBack(request, reply, subscriptionPath(show.slug), error.message, 'err');
        }
        reply.status(422);
        return renderForm(reply, { show, subscription: existing, errors: error.fields, values: body });
      }
    });

    scoped.post('/ui/shows/:slug/subscription/preview', async (request, reply) => {
      const show = findShow(request.params.slug);
      const body = request.body ?? {};
      try {
        const preview = await services.remoteFeeds.preview(String(body.feedUrl ?? ''), {
          includeKeywords: normaliseKeywords(body.includeKeywords),
          excludeKeywords: normaliseKeywords(body.excludeKeywords),
          minDurationSeconds: minutesToSeconds(body.minDurationMinutes),
          maxDurationSeconds: minutesToSeconds(body.maxDurationMinutes),
        });
        if (!isHtmx(request)) {
          return redirectBack(request, reply, subscriptionPath(show.slug), `That feed has ${preview.matchCount} matching episodes.`);
        }
        return reply.view('partials/subscription-preview.eta', { preview, helpers: fastify.viewHelpers });
      } catch (error) {
        if (!isHtmx(request)) {
          return redirectBack(request, reply, subscriptionPath(show.slug), error.message, 'err');
        }
        return reply.view('partials/subscription-preview.eta', {
          problem: error.message,
          helpers: fastify.viewHelpers,
        });
      }
    });

    scoped.post('/ui/subscriptions/:id/poll', async (request, reply) => {
      const subscription = services.subscriptions.getOrThrow(request.params.id);
      const show = shows.getOrThrow(subscription.show_id);
      let message = 'Checked.';
      let level = 'ok';
      try {
        const result = await services.remoteFeeds.pollNow(subscription.id);
        message =
          result.status === 'not_modified'
            ? 'Nothing new since the last check.'
            : `Checked — ${result.downloaded ?? 0} new ${(result.downloaded ?? 0) === 1 ? 'episode' : 'episodes'} downloaded.`;
        if (result.status !== 'ok' && result.status !== 'not_modified') {
          message = result.error ?? 'That feed could not be checked.';
          level = 'err';
        }
      } catch (error) {
        message = error.message;
        level = 'err';
      }
      return redirectBack(request, reply, subscriptionPath(show.slug), message, level);
    });

    scoped.post('/ui/subscriptions/:id/toggle', async (request, reply) => {
      const subscription = services.subscriptions.getOrThrow(request.params.id);
      const show = shows.getOrThrow(subscription.show_id);
      const updated = services.subscriptions.update(subscription.id, {
        enabled: !subscription.enabled,
      });
      return redirectBack(
        request,
        reply,
        subscriptionPath(show.slug),
        updated.enabled ? 'Following again.' : 'Paused. Nothing new will be downloaded until you resume.',
      );
    });

    scoped.post('/ui/subscriptions/:id/delete', async (request, reply) => {
      const subscription = services.subscriptions.getOrThrow(request.params.id);
      const show = shows.getOrThrow(subscription.show_id);
      services.subscriptions.remove(subscription.id);
      return redirectBack(
        request,
        reply,
        subscriptionPath(show.slug),
        'Stopped following that feed. The episodes it already downloaded are untouched.',
      );
    });

    scoped.get('/ui/subscriptions/:id/items', async (request, reply) => {
      const subscription = services.subscriptions.getOrThrow(request.params.id);
      const show = shows.getOrThrow(subscription.show_id);
      const context = services.ledgerContext(subscription, request);
      // Changing a filter is a navigation: the address bar has to end up somewhere
      // that reloads into the same view.
      reply.header(
        'HX-Push-Url',
        `${subscriptionPath(show.slug)}${context.filter.qs ? `?${context.filter.qs}` : ''}`,
      );
      return reply.view('partials/subscription-items.eta', context);
    });

    /* The table alone, which is what a filter replaces. Swapping the whole card
       instead would take the search box out of the document between keystrokes and
       the cursor with it. */
    scoped.get('/ui/subscriptions/:id/items/table', async (request, reply) => {
      const subscription = services.subscriptions.getOrThrow(request.params.id);
      const show = shows.getOrThrow(subscription.show_id);
      const context = services.ledgerContext(subscription, request);
      reply.header(
        'HX-Push-Url',
        `${subscriptionPath(show.slug)}${context.filter.qs ? `?${context.filter.qs}` : ''}`,
      );
      return reply.view('partials/subscription-ledger.eta', context);
    });

    /* Rows only, so "Show older" appends a page instead of replacing the card it
       lives inside — the same split the access log uses, for the same reason. */
    scoped.get('/ui/subscriptions/:id/items/rows', async (request, reply) => {
      const subscription = services.subscriptions.getOrThrow(request.params.id);
      reply.header('HX-Push-Url', 'false');
      return reply.view('partials/subscription-item-rows.eta', services.ledgerContext(subscription, request));
    });

    /** Back to the queue, with everything a previous decision left behind cleared. */
    function queueItem(item) {
      services.subscriptions.markItem(item.id, {
        decision: ITEM_DECISION.MATCHED,
        reject_reason: null,
        reject_detail: null,
        episode_id: null,
        filename: null,
        identity_key: null,
        attempts: 0,
        next_attempt_at: null,
      });
    }

    /**
     * Queue everything that was ticked.
     *
     * Ticked rows are ordinary form fields, so this works with JavaScript switched off:
     * the select-all box is the only part of the selection that needs it, and it is an
     * enhancement over checkboxes that already post.
     *
     * Nothing here downloads. Each poll takes a bounded number of queued episodes, so
     * selecting four hundred of them queues four hundred and spends the bandwidth over
     * days rather than in one burst — which the wording says, because a button that
     * silently starts a multi-gigabyte fetch is not a button anyone can consent to.
     */
    scoped.post('/ui/subscriptions/:id/items/redownload', async (request, reply) => {
      const subscription = services.subscriptions.getOrThrow(request.params.id);
      const show = shows.getOrThrow(subscription.show_id);
      const raw = request.body?.itemIds;
      const ids = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw])
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value));

      let queued = 0;
      let blocked = 0;
      for (const id of ids) {
        const item = services.subscriptions.getItem(id);
        // Silently ignoring an id from another subscription rather than throwing: the
        // only way to send one is by hand, and a 404 on a bulk action would throw away
        // the rest of a selection that was perfectly valid.
        if (!item || item.subscription_id !== subscription.id) continue;
        if (item.decision === ITEM_DECISION.REJECTED_BLOCKED) {
          blocked += 1;
          continue;
        }
        queueItem(item);
        queued += 1;
      }

      const message = queued
        ? `${queued} episode${queued === 1 ? '' : 's'} queued for the next check` +
          `${queued > REMOTE_MAX_ITEMS_PER_POLL ? `, at up to ${REMOTE_MAX_ITEMS_PER_POLL} a check` : ''}.` +
          (blocked ? ` ${blocked} could not be: their audio is on a private address.` : '')
        : blocked
          ? `Those ${blocked === 1 ? 'episode has' : 'episodes have'} audio on a private address, which SelfPod will not fetch from.`
          : 'Nothing was selected, so nothing was queued.';
      const level = queued ? 'ok' : 'err';

      if (!isHtmx(request)) {
        const qs = services.ledgerFilter(request).qs;
        return redirectBack(
          request,
          reply,
          `${subscriptionPath(show.slug)}${qs ? `?${qs}` : ''}`,
          message,
          level,
        );
      }
      /* The card is re-rendered whatever happened, and the toast rides along out of
         band — the same pairing the episode table uses. Without it a selection that
         was entirely refused would swap in an unchanged table and say nothing. */
      const context = services.ledgerContext(subscription, request);
      const card = await reply.viewAsync('partials/subscription-items.eta', context);
      const toast = await reply.viewAsync('partials/toast.eta', {
        message,
        level,
        helpers: fastify.viewHelpers,
      });
      return reply.type('text/html; charset=utf-8').send(`${card}${toast}`);
    });

    scoped.post('/ui/subscriptions/:id/items/:itemId/redownload', async (request, reply) => {
      const subscription = services.subscriptions.getOrThrow(request.params.id);
      const show = shows.getOrThrow(subscription.show_id);
      const item = services.subscriptions.getItem(Number(request.params.itemId));
      if (!item || item.subscription_id !== subscription.id) {
        throw notFound('That episode is not in this subscription.', 'item_not_found');
      }
      if (item.decision === ITEM_DECISION.REJECTED_BLOCKED) {
        // Never undoable from the UI: it was refused because its audio is on an
        // address SelfPod must not reach, and a button that overrode that would be a
        // button that reaches it.
        return redirectBack(
          request,
          reply,
          subscriptionPath(show.slug),
          "That episode's audio is on a private or local address, which SelfPod will not fetch from.",
          'err',
        );
      }
      queueItem(item);
      if (!isHtmx(request)) {
        const qs = services.ledgerFilter(request).qs;
        return redirectBack(
          request,
          reply,
          `${subscriptionPath(show.slug)}${qs ? `?${qs}` : ''}`,
          'Queued for the next check.',
        );
      }
      return renderItems(reply, subscription, request);
    });

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

    scoped.get('/ui/shows/:slug/readiness', async (request, reply) => {
      const show = findShow(request.params.slug);
      return reply.view('partials/feed-readiness.eta', {
        show: presentShow(show, { includeReadiness: true }),
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
        itunesType: body.itunesType,
        directoryListing: body.directoryListing,
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
            episodeType: body.episodeType,
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
    /**
     * Re-render the episode table, and say what just happened.
     *
     * The toast used to be dropped on the floor here: the arguments were accepted and
     * then voided, so removing an episode with JavaScript on gave no confirmation at
     * all, while the same action without it flashed a message correctly. The toast
     * partial swaps itself out of band into #toast-root, so appending it to a response
     * aimed at #episode-table is all it takes.
     */
    async function renderEpisodeTableWithToast(reply, show, message, level = 'ok') {
      reply.header('HX-Retarget', '#episode-table');
      reply.header('HX-Reswap', 'outerHTML');
      reply.header('HX-Trigger', 'selfpod:modal-close');
      /* `viewAsync`, not `view`: `reply.view` renders *and sends*, so a second call
         appended to its return value is two objects concatenated into a response that
         has already gone out. That is how the toast came to be dropped on the floor a
         second time after being fixed once. `viewAsync` hands back the HTML and
         nothing is sent until the send below. */
      const table = await reply.viewAsync('partials/episode-table.eta', {
        show: presentShow(show),
        episodes: episodes.listByShow(show.id).map((e) => presentEpisode(e, show)),
        helpers: fastify.viewHelpers,
      });
      const toast = message
        ? await reply.viewAsync('partials/toast.eta', { message, level, helpers: fastify.viewHelpers })
        : '';
      return reply.type('text/html; charset=utf-8').send(`${table}${toast}`);
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

    /**
     * The scan log and the episode timeline.
     *
     * Each has two routes: one that rebuilds the card when a filter changes, and one
     * that returns only the next page of items for the pager to append. The pager used
     * to reuse the first — which returned the whole container — so every "Load more"
     * nested another element with the same id inside the one before it.
     */
    function scanLogContext(request) {
      const filter = services.activityFilter(request);
      const entries = activity.list({
        ...filter.scanQuery,
        limit: services.activityPageSize,
        offset: filter.offset,
      });
      const total = activity.count(filter.scanQuery);
      return {
        filter,
        entries,
        total,
        showFilter: filter.scanSlug,
        loaded: filter.offset + entries.length,
        hasMore: filter.offset + entries.length < total,
        nextOffset: filter.offset + entries.length,
        helpers: fastify.viewHelpers,
      };
    }

    function timelineContext(request) {
      const filter = services.activityFilter(request);
      const entries = services.timeline.list({
        ...filter.timelineQuery,
        limit: services.activityPageSize,
        offset: filter.timelineOffset,
      });
      const total = services.timeline.count(filter.timelineQuery);
      return {
        filter,
        entries,
        total,
        loaded: filter.timelineOffset + entries.length,
        hasMore: filter.timelineOffset + entries.length < total,
        nextOffset: filter.timelineOffset + entries.length,
        helpers: fastify.viewHelpers,
      };
    }

    scoped.get('/ui/activity', async (request, reply) => {
      const context = scanLogContext(request);
      // Fetched from /ui/activity, but what someone should be able to reload, bookmark
      // and go Back to is /activity with the same filters.
      reply.header('HX-Push-Url', services.activityPageUrl(context.filter));
      return reply.view('partials/activity-list.eta', context);
    });

    scoped.get('/ui/activity/items', async (request, reply) => {
      // Paging is not a filter — see the note on offset in pages.js.
      reply.header('HX-Push-Url', 'false');
      return reply.view('partials/activity-items.eta', scanLogContext(request));
    });

    scoped.get('/ui/activity/timeline', async (request, reply) => {
      const context = timelineContext(request);
      reply.header('HX-Push-Url', services.activityPageUrl(context.filter));
      return reply.view('partials/episode-timeline.eta', context);
    });

    scoped.get('/ui/activity/timeline/items', async (request, reply) => {
      reply.header('HX-Push-Url', 'false');
      return reply.view('partials/episode-timeline-items.eta', timelineContext(request));
    });

    /* ----------------------------------------------------------- statistics */

    function accessLogContext(request) {
      const filter = services.logFilter(request);
      const entries = services.stats.list({
        ...filter.query,
        limit: services.logPageSize,
        offset: filter.offset,
      });
      const total = services.stats.count(filter.query);

      return {
        log: filter,
        entries,
        total,
        showFilter: filter.slug,
        failuresOnly: filter.failuresOnly,
        loaded: filter.offset + entries.length,
        hasMore: filter.offset + entries.length < total,
        nextOffset: filter.offset + entries.length,
        helpers: fastify.viewHelpers,
      };
    }

    scoped.get('/ui/stats/log', async (request, reply) => {
      const context = accessLogContext(request);
      reply.header('HX-Push-Url', services.statsPageUrl(context.log));
      return reply.view('partials/access-log.eta', context);
    });

    scoped.get('/ui/stats/log/rows', async (request, reply) => {
      reply.header('HX-Push-Url', 'false');
      return reply.view('partials/access-log-rows.eta', accessLogContext(request));
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
        options: () => fastify.viewHelpers.languages.map((l) => ({ value: l.code, label: l.label })),
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
      /*
       * These three were seeded at first boot and readable through the API, but had no
       * write path anywhere — so every show SelfPod discovered got "Technology" and
       * there was no way to change that short of editing each show afterwards.
       */
      defaultCategory: {
        title: 'Default category',
        description: 'Applied to shows SelfPod discovers on its own. Existing shows keep what they have.',
        options: () =>
          Object.keys(fastify.viewHelpers.categories).map((name) => ({ value: name, label: name })),
        read: () => settings.defaults().category,
        display: () => settings.defaults().category,
        write(value) {
          const category = String(value ?? '').trim();
          if (!isValidCategory(category)) return { error: "That isn't one of Apple's categories." };
          const patch = { [SETTING_KEYS.DEFAULT_CATEGORY]: category };
          // A subcategory belongs to exactly one category, so one that no longer fits
          // has to go with it — otherwise the pair reaches a feed as a nested
          // itunes:category that Apple rejects.
          const subcategory = settings.defaults().subcategory;
          if (subcategory && !isValidSubcategory(category, subcategory)) {
            patch[SETTING_KEYS.DEFAULT_SUBCATEGORY] = '';
          }
          return { patch };
        },
      },
      defaultSubcategory: {
        title: 'Default subcategory',
        options: () => [
          { value: '', label: 'None' },
          ...(fastify.viewHelpers.categories[settings.defaults().category] ?? []).map((name) => ({
            value: name,
            label: name,
          })),
        ],
        read: () => settings.defaults().subcategory ?? '',
        display: () => settings.defaults().subcategory || 'None',
        write(value) {
          const subcategory = String(value ?? '').trim();
          if (subcategory && !isValidSubcategory(settings.defaults().category, subcategory)) {
            return { error: `"${subcategory}" isn't a subcategory of ${settings.defaults().category}.` };
          }
          return { patch: { [SETTING_KEYS.DEFAULT_SUBCATEGORY]: subcategory } };
        },
      },
      defaultExplicit: {
        title: 'Default explicit flag',
        options: () => [
          { value: '0', label: 'No' },
          { value: '1', label: 'Yes' },
        ],
        read: () => (settings.defaults().explicit ? '1' : '0'),
        display: () => (settings.defaults().explicit ? 'Yes' : 'No'),
        write(value) {
          return { patch: { [SETTING_KEYS.DEFAULT_EXPLICIT]: value === '1' ? '1' : '0' } };
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
        options: row.options?.() ?? null,
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

    scoped.post('/ui/settings/subscriptions', async (request, reply) => {
      const enabled =
        request.body?.subscriptionsEnabled === '1' || request.body?.subscriptionsEnabled === 'on';
      settings.update({ [SETTING_KEYS.SUBSCRIPTIONS_ENABLED]: enabled ? '1' : '0' });

      if (!isHtmx(request)) {
        return redirectBack(
          request,
          reply,
          '/settings',
          enabled
            ? 'SelfPod can now follow podcast feeds. Set the rules on a show\'s own page.'
            : 'Feed following switched off. SelfPod will not fetch from the internet.',
        );
      }
      // Whole-page refresh: every show page's subscription section reads this, and
      // the banner it controls is not part of this fragment.
      reply.header('HX-Refresh', 'true');
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
