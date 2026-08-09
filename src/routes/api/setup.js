import { conflict, unprocessable } from '../../lib/errors.js';
import { normaliseBaseUrl } from '../../lib/urls.js';
import { SETTING_KEYS } from '../../services/settings.js';

export const MIN_PASSWORD_LENGTH = 10;

/**
 * First-run wizard (spec §11.1).
 *
 * Requires an authenticated session. Bootstrap always creates a credential before
 * the server starts listening, so there is no window in which the app is reachable
 * with no password — which means no unauthenticated "choose a password" endpoint
 * needs to exist, and an instance exposed through a tunnel before its first login
 * cannot be claimed by a stranger.
 */
export default async function setupRoutes(fastify, { settings, events, shows }) {
  fastify.post('/setup', { preHandler: fastify.requireAdminApi }, async (request) => {
    if (settings.setupComplete()) {
      throw conflict('Setup has already been completed. Change these values in Settings instead.', 'setup_complete');
    }

    const body = request.body ?? {};
    const fields = {};
    const patch = {};

    // 1. Password. Required whenever the current one was auto-generated.
    const wantsPassword = Boolean(body.password) || settings.mustChangePassword();
    if (wantsPassword) {
      const password = String(body.password ?? '');
      const confirm = String(body.passwordConfirm ?? body.password_confirm ?? '');
      if (password.length < MIN_PASSWORD_LENGTH) {
        fields.password = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
      } else if (confirm && password !== confirm) {
        fields.passwordConfirm = "Those two passwords don't match.";
      }
      if (!fields.password && !fields.passwordConfirm) {
        await fastify.setAdminPassword(password);
      }
    }

    // 2. Public base URL — the wizard cannot complete without a valid one, since
    //    every URL in every feed is built from it.
    const rawBaseUrl = body.publicBaseUrl ?? body.public_base_url;
    if (rawBaseUrl !== undefined) {
      const normalised = normaliseBaseUrl(String(rawBaseUrl));
      if (!normalised) {
        fields.publicBaseUrl =
          'Include the scheme and host, for example https://podcast.example.com — this is the address your reverse proxy serves SelfPod on.';
      } else {
        patch[SETTING_KEYS.PUBLIC_BASE_URL] = normalised;
      }
    }

    // 3. Defaults for future shows.
    if (body.defaultAuthorName !== undefined) {
      patch[SETTING_KEYS.DEFAULT_AUTHOR_NAME] = String(body.defaultAuthorName).trim().slice(0, 200);
    }
    if (body.defaultAuthorEmail !== undefined) {
      const email = String(body.defaultAuthorEmail).trim();
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        fields.defaultAuthorEmail = "That doesn't look like an email address.";
      } else {
        patch[SETTING_KEYS.DEFAULT_AUTHOR_EMAIL] = email.slice(0, 200);
      }
    }
    if (body.defaultLanguage !== undefined) {
      patch[SETTING_KEYS.DEFAULT_LANGUAGE] = String(body.defaultLanguage).trim().toLowerCase() || 'en';
    }

    const finish = body.finish === true || body.finish === 'true' || body.finish === '1';
    if (finish) {
      const baseUrl = patch[SETTING_KEYS.PUBLIC_BASE_URL] ?? settings.publicBaseUrl();
      if (!baseUrl) {
        fields.publicBaseUrl = 'SelfPod needs its public address before it can build feed URLs.';
      }
      if (settings.mustChangePassword() && !body.password) {
        fields.password = 'Choose your own password before finishing setup.';
      }
    }

    if (Object.keys(fields).length) {
      throw unprocessable('Some of those values need fixing.', 'validation_failed', fields);
    }

    if (finish) patch[SETTING_KEYS.SETUP_COMPLETE] = '1';
    if (Object.keys(patch).length) settings.update(patch);
    if (finish) shows.applyDefaultsToBlankShows();

    void events;
    return {
      ok: true,
      setupComplete: settings.setupComplete(),
      mustChangePassword: settings.mustChangePassword(),
      publicBaseUrl: settings.publicBaseUrl(),
    };
  });
}
