import { unauthorized } from '../../lib/errors.js';

/**
 * Sign-in and sign-out. Rate limiting is handled inside `verifyCredentials`,
 * which combines a source key that a client cannot spoof with an account-level
 * backoff (see plugins/auth.js).
 */
export default async function authRoutes(fastify, { settings }) {
  fastify.post('/login', async (request, reply) => {
    const { username, password } = request.body ?? {};
    const result = await fastify.verifyCredentials(username, password, request);

    if (!result.ok) {
      if (result.retryAfter) reply.header('retry-after', String(result.retryAfter));
      throw unauthorized(result.message, result.retryAfter ? 'rate_limited' : 'invalid_credentials');
    }

    request.session.set('admin', { username: result.username, since: new Date().toISOString() });
    await request.session.save();

    return {
      ok: true,
      mustChangePassword: settings.mustChangePassword(),
      setupComplete: settings.setupComplete(),
    };
  });

  fastify.post('/logout', async (request) => {
    await request.session.destroy();
    return { ok: true };
  });

  fastify.get('/me', { preHandler: fastify.requireAdminApi }, async (request) => ({
    username: request.session.get('admin')?.username ?? settings.adminUsername(),
    mustChangePassword: settings.mustChangePassword(),
    setupComplete: settings.setupComplete(),
  }));
}
