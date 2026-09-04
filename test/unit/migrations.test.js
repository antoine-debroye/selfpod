import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import Database from 'better-sqlite3';

import { runMigrations } from '../../src/db/migrate.js';

/**
 * Migration 009 rebuilds the advert catalogue to widen a CHECK constraint. A rebuild
 * that lost the owner's decisions, or the cut list under them, would publish every
 * episode with its adverts back in after an upgrade — silently. So the rows are seeded
 * in the 008 shape and followed across.
 */
function seededAt008() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, { upTo: 8 });
  assert.equal(db.pragma('user_version', { simple: true }), 8);

  const now = '2026-09-01T00:00:00.000Z';
  db.prepare(
    `INSERT INTO shows (id, slug, title, author_name, author_email, feed_token, created_at, updated_at)
     VALUES ('s1', 'show', 'Show', 'A', 'a@example.com', 'tok', ?, ?)`,
  ).run(now, now);
  const episode = db.prepare(
    `INSERT INTO episodes (id, show_id, filename, identity_key, title, pub_date, file_size_bytes, mime_type, created_at, updated_at)
     VALUES (?, 's1', ?, ?, ?, ?, 1000, 'audio/mpeg', ?, ?)`,
  );
  episode.run('e1', 'a.mp3', 'k1', 'A', now, now, now);
  episode.run('e2', 'b.mp3', 'k2', 'B', now, now, now);
  db.prepare(
    `INSERT INTO ad_segments
       (id, show_id, signature, source, status, auto_approved, hold_reason, duration_ms,
        episode_count, occurrence_count, exemplar_episode_id, exemplar_start_ms, exemplar_end_ms,
        first_seen_at, decided_at, created_at, updated_at)
     VALUES ('seg1', 's1', 'sig', 'corpus', 'approved', 0, NULL, 30000, 2, 2, 'e1', 1000, 31000, ?, ?, ?, ?)`,
  ).run(now, now, now, now);
  db.prepare(
    `INSERT INTO ad_segment_occurrences (segment_id, episode_id, start_frame, end_frame, start_ms, end_ms)
     VALUES ('seg1', 'e1', 38, 1188, 1000, 31000), ('seg1', 'e2', 40, 1190, 1050, 31050)`,
  ).run();
  return db;
}

describe('migration 009 rebuilds the catalogue without losing it', () => {
  it('keeps every segment, decision and occurrence, and the foreign keys hold', () => {
    const db = seededAt008();
    runMigrations(db);

    const segment = db.prepare('SELECT * FROM ad_segments WHERE id = ?').get('seg1');
    assert.equal(segment.status, 'approved');
    assert.equal(segment.exemplar_episode_id, 'e1');
    assert.equal(segment.text, null, 'new columns start empty');

    const occurrences = db
      .prepare('SELECT * FROM ad_segment_occurrences WHERE segment_id = ? ORDER BY episode_id')
      .all('seg1');
    assert.equal(occurrences.length, 2, 'the cut list survived the rebuild');
    assert.deepEqual(
      occurrences.map((row) => [row.episode_id, row.start_frame, row.end_frame]),
      [['e1', 38, 1188], ['e2', 40, 1190]],
    );

    assert.deepEqual(db.pragma('foreign_key_check'), [], 'no dangling references');
  });

  it('widened the source constraint and re-pointed the cascade', () => {
    const db = seededAt008();
    runMigrations(db);
    const now = '2026-09-02T00:00:00.000Z';

    db.prepare(
      `INSERT INTO ad_segments
         (id, show_id, signature, source, status, duration_ms, first_seen_at, created_at, updated_at, text)
       VALUES ('seg2', 's1', 'tx:abc', 'transcript', 'candidate', 20000, ?, ?, ?, 'brought to you by acme')`,
    ).run(now, now, now);
    db.prepare(
      `INSERT INTO ad_segment_occurrences (segment_id, episode_id, start_frame, end_frame, start_ms, end_ms)
       VALUES ('seg2', 'e2', 0, 700, 0, 20000)`,
    ).run();

    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO ad_segments (id, show_id, signature, source, status, duration_ms, first_seen_at, created_at, updated_at)
             VALUES ('bad', 's1', 'x', 'guess', 'candidate', 1, ?, ?, ?)`,
          )
          .run(now, now, now),
      /CHECK/,
      'an unknown source is still refused',
    );

    // Deleting a segment must still take its occurrences with it, which is only true
    // if the renamed child points at the renamed parent.
    db.prepare('DELETE FROM ad_segments WHERE id = ?').run('seg2');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM ad_segment_occurrences WHERE segment_id = ?').get('seg2').n,
      0,
    );
    // And the indexes came back under their old names.
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((row) => row.name);
    assert.ok(indexes.includes('idx_ad_segments_show'));
    assert.ok(indexes.includes('idx_ad_occurrences_episode'));
  });

  it('adds the transcript tables and the per-show listening settings', () => {
    const db = seededAt008();
    runMigrations(db);
    const show = db.prepare('SELECT ad_transcribe, ad_transcribe_head_seconds, ad_transcribe_tail_seconds FROM shows').get();
    assert.deepEqual(show, { ad_transcribe: 'edges', ad_transcribe_head_seconds: 300, ad_transcribe_tail_seconds: 240 });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
    assert.ok(tables.includes('episode_transcripts'));
    assert.ok(tables.includes('ad_markers'));
  });
});
