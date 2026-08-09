import fastifyCookie from '@fastify/cookie';
import fastifySession from '@fastify/session';
import fp from 'fastify-plugin';

/**
 * Session support backed by the same SQLite file as everything else.
 *
 * Nothing about a signed-in admin lives outside `/data`: the signing secret is a
 * settings row and the sessions are a table, so a container restart — or moving
 * the volume to a new machine — does not sign the user out. That is the whole
 * "easy to migrate" promise, applied to sessions.
 */
class SqliteSessionStore {
  constructor(db, { logger } = {}) {
    this.logger = logger;
    this.selectStmt = db.prepare('SELECT data, expires_at FROM sessions WHERE sid = ?');
    this.upsertStmt = db.prepare(
      `INSERT INTO sessions (sid, data, expires_at) VALUES (@sid, @data, @expiresAt)
       ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`,
    );
    this.deleteStmt = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.cleanupStmt = db.prepare('DELETE FROM sessions WHERE expires_at < ?');
  }

  set(sid, session, callback) {
    try {
      const expiresAt = session?.cookie?.expires
        ? new Date(session.cookie.expires).toISOString()
        : new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
      this.upsertStmt.run({ sid, data: JSON.stringify(session), expiresAt });
      callback(null);
    } catch (err) {
      this.logger?.error({ err }, 'could not save session');
      callback(err);
    }
  }

  get(sid, callback) {
    try {
      const row = this.selectStmt.get(sid);
      if (!row) return callback(null, null);
      if (new Date(row.expires_at).getTime() < Date.now()) {
        this.deleteStmt.run(sid);
        return callback(null, null);
      }
      return callback(null, JSON.parse(row.data));
    } catch (err) {
      this.logger?.error({ err }, 'could not read session');
      return callback(err);
    }
  }

  destroy(sid, callback) {
    try {
      this.deleteStmt.run(sid);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  /** Called from the scheduler's tick. */
  cleanup() {
    const info = this.cleanupStmt.run(new Date().toISOString());
    return info.changes;
  }
}

async function sessionPlugin(fastify, { db, settings, logger }) {
  const secret = settings.sessionSecret();
  if (!secret || secret.length < 32) {
    throw new Error('session secret missing — bootstrap must run before the server starts');
  }

  const store = new SqliteSessionStore(db, { logger });
  const ttlMs = settings.sessionTtlHours() * 60 * 60 * 1000;

  await fastify.register(fastifyCookie);
  await fastify.register(fastifySession, {
    secret,
    store,
    cookieName: 'selfpod.sid',
    saveUninitialized: false,
    rolling: true,
    cookie: {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: ttlMs,
      // 'auto' marks the cookie Secure only when the request arrived over HTTPS.
      // With trustProxy on, that is decided by X-Forwarded-Proto, so a tunnel gets
      // Secure cookies while a plain-HTTP LAN address still works. The two origins
      // keep separate cookie jars, so signing in on both is expected.
      secure: 'auto',
    },
  });

  fastify.decorate('sessionStore', store);
  fastify.decorate('cleanupSessions', () => store.cleanup());
}

export default fp(sessionPlugin, { name: 'selfpod-session' });
