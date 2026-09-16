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

/**
 * Migration 010 is purely additive — two new tables, nothing altered — so unlike 009
 * there is nothing to rebuild and nothing that could be lost. What has to be proved
 * is narrower: that a marker taught before the upgrade is still there to be linked
 * to an anchor, and that the new tables' foreign keys are wired to the right parents.
 */
function seededAt009() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, { upTo: 9 });
  assert.equal(db.pragma('user_version', { simple: true }), 9);

  const now = '2026-09-10T00:00:00.000Z';
  db.prepare(
    `INSERT INTO shows (id, slug, title, author_name, author_email, feed_token, created_at, updated_at)
     VALUES ('s1', 'show', 'Show', 'A', 'a@example.com', 'tok', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO episodes (id, show_id, filename, identity_key, title, pub_date, file_size_bytes, mime_type, created_at, updated_at)
     VALUES ('e1', 's1', 'a.mp3', 'k1', 'A', ?, 1000, 'audio/mpeg', ?, ?)`,
  ).run(now, now, now);
  db.prepare(
    `INSERT INTO ad_markers (id, show_id, role, inclusive, text, raw_text, language, created_at)
     VALUES ('m1', 's1', 'programme_starts', 0, 'vous ecoutez rmc', 'Vous écoutez RMC', 'fr', ?)`,
  ).run(now);
  db.prepare(
    `INSERT INTO ad_segments
       (id, show_id, signature, source, status, auto_approved, hold_reason, duration_ms,
        episode_count, occurrence_count, exemplar_episode_id, exemplar_start_ms, exemplar_end_ms,
        first_seen_at, decided_at, created_at, updated_at)
     VALUES ('seg1', 's1', 'marker:m1', 'transcript', 'approved', 0, NULL, 9000, 1, 1, 'e1', 0, 9000, ?, ?, ?, ?)`,
  ).run(now, now, now, now);
  db.prepare(
    `INSERT INTO ad_segment_occurrences (segment_id, episode_id, start_frame, end_frame, start_ms, end_ms)
     VALUES ('seg1', 'e1', 0, 345, 0, 9000)`,
  ).run();
  return db;
}

describe('migration 010 adds the audio anchor tables', () => {
  it('keeps every existing marker, segment and occurrence untouched', () => {
    const db = seededAt009();
    runMigrations(db, { upTo: 10 });
    assert.equal(db.pragma('user_version', { simple: true }), 10);

    const marker = db.prepare('SELECT * FROM ad_markers WHERE id = ?').get('m1');
    assert.equal(marker.raw_text, 'Vous écoutez RMC', 'the taught boundary survived untouched');

    const segment = db.prepare('SELECT * FROM ad_segments WHERE id = ?').get('seg1');
    assert.equal(segment.status, 'approved');
    assert.equal(segment.signature, 'marker:m1');

    const occurrences = db.prepare('SELECT * FROM ad_segment_occurrences WHERE segment_id = ?').all('seg1');
    assert.equal(occurrences.length, 1);

    assert.deepEqual(db.pragma('foreign_key_check'), [], 'no dangling references');
  });

  it('adds ad_anchors and ad_anchor_hits, wired to their parents', () => {
    const db = seededAt009();
    runMigrations(db);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
    assert.ok(tables.includes('ad_anchors'));
    assert.ok(tables.includes('ad_anchor_hits'));

    const now = '2026-09-10T00:00:01.000Z';
    db.prepare(
      `INSERT INTO ad_anchors
         (id, show_id, marker_id, origin, algorithm_version, clip, lead_ms,
          exemplar_episode_id, exemplar_start_ms, exemplar_end_ms, created_at, updated_at)
       VALUES ('a1', 's1', 'm1', 'from_marker', 2, x'0102', 800, 'e1', 1000, 3500, ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO ad_anchor_hits (anchor_id, episode_id, heard, at_ms, ber, checked_at)
       VALUES ('a1', 'e1', 1, 9200, 0.07, ?)`,
    ).run(now);

    assert.deepEqual(db.pragma('foreign_key_check'), [], 'no dangling references');

    // Deleting the marker must not take the anchor with it — only null its link, so
    // the clip and every recorded hit survive a marker the owner later removes.
    db.prepare('DELETE FROM ad_markers WHERE id = ?').run('m1');
    const anchor = db.prepare('SELECT * FROM ad_anchors WHERE id = ?').get('a1');
    assert.equal(anchor.marker_id, null, 'the anchor outlives the marker it was linked from');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ad_anchor_hits WHERE anchor_id = ?').get('a1').n, 1);

    // Deleting the anchor's own show cascades through both new tables.
    db.prepare('DELETE FROM shows WHERE id = ?').run('s1');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ad_anchors').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ad_anchor_hits').get().n, 0);
  });
});

/**
 * Migration 011 classifies every catalogue row by kind, adds per-episode restores and
 * the columns a pass uses to skip work. It is additive, so the thing to prove is not
 * only that nothing is lost but that 1.8.8 still runs against the result: a rollback
 * is an owner changing an image tag back, and it has to be harmless.
 */
function seededAt010() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, { upTo: 10 });
  assert.equal(db.pragma('user_version', { simple: true }), 10);

  const now = '2026-09-15T00:00:00.000Z';
  db.prepare(
    `INSERT INTO shows (id, slug, title, author_name, author_email, feed_token, created_at, updated_at)
     VALUES ('s1', 'show', 'Show', 'A', 'a@example.com', 'tok', ?, ?)`,
  ).run(now, now);
  const episode = db.prepare(
    `INSERT INTO episodes (id, show_id, filename, identity_key, title, pub_date, file_size_bytes, mime_type,
                           trimmed_filename, trim_status, publish_hold, created_at, updated_at)
     VALUES (?, 's1', ?, ?, ?, ?, 1000, 'audio/mpeg', ?, ?, ?, ?, ?)`,
  );
  episode.run('e1', 'a.mp3', 'k1', 'A', now, 'e1.abcdef012345.mp3', 'trimmed', null, now, now);
  episode.run('e2', 'b.mp3', 'k2', 'B', now, null, null, 'awaiting_corpus', now, '2026-09-15T01:00:00.000Z');
  db.prepare(
    `INSERT INTO ad_markers (id, show_id, role, inclusive, text, raw_text, language, created_at)
     VALUES ('m1', 's1', 'programme_starts', 0, 'vous ecoutez rmc', 'Vous écoutez RMC', 'fr', ?)`,
  ).run(now);
  db.prepare(
    `INSERT INTO ad_anchors (id, show_id, origin, confirmed_at, algorithm_version, clip, lead_ms,
                             exemplar_episode_id, exemplar_start_ms, exemplar_end_ms, created_at, updated_at)
     VALUES ('a1', 's1', 'proposed', ?, 2, x'0102', 800, 'e1', 1000, 3500, ?, ?)`,
  ).run(now, now, now);

  const segment = db.prepare(
    `INSERT INTO ad_segments
       (id, show_id, signature, source, status, auto_approved, hold_reason, duration_ms,
        episode_count, occurrence_count, exemplar_episode_id, exemplar_start_ms, exemplar_end_ms,
        first_seen_at, decided_at, created_at, updated_at, text, raw_text, cue_score, cues)
     VALUES (@id, 's1', @signature, @source, @status, 0, @hold, 9000, 1, 1, 'e1', 0, 9000,
             @now, NULL, @now, @now, @text, @text, @score, @cues)`,
  );
  const rows = [
    { id: 'boundary', signature: 'marker:m1', source: 'transcript', status: 'approved', text: 'vous ecoutez rmc' },
    { id: 'jingle', signature: 'anchor:a1', source: 'corpus', status: 'approved' },
    { id: 'orphan-marker', signature: 'marker:gone', source: 'transcript', status: 'approved', text: 'x y z' },
    { id: 'audio', signature: '0123456789abcdef01234567', source: 'corpus', status: 'approved' },
    { id: 'audio-with-words', signature: '89abcdef0123456789abcdef', source: 'corpus', status: 'candidate', text: 'theme words', score: 0.1, cues: '[]' },
    { id: 'diff', signature: 'fedcba9876543210fedcba98', source: 'diff', status: 'approved' },
    { id: 'taught', signature: 'tx:aaaaaaaaaaaaaaaaaaaaaaaa', source: 'transcript', status: 'approved', text: 'code promo rmc' },
    { id: 'repeated', signature: 'tx:bbbbbbbbbbbbbbbbbbbbbbbb', source: 'transcript', status: 'candidate', text: 'banque populaire', score: 0.8, cues: '["sponsored_by"]' },
    { id: 'once-undecided', signature: 'tx:cccccccccccccccccccccccc', source: 'transcript', status: 'candidate', hold: 'only_heard_once', text: 'sfr offre', score: 0.7, cues: '["price"]' },
    { id: 'once-decided', signature: 'tx:dddddddddddddddddddddddd', source: 'transcript', status: 'approved', hold: 'only_heard_once', text: 'volkswagen', score: 0.7, cues: '["price"]' },
  ];
  for (const row of rows) {
    segment.run({ hold: null, text: null, score: null, cues: null, now, ...row });
    db.prepare(
      `INSERT INTO ad_segment_occurrences (segment_id, episode_id, start_frame, end_frame, start_ms, end_ms)
       VALUES (?, 'e1', 0, 345, 0, 9000)`,
    ).run(row.id);
  }
  db.prepare(
    `INSERT INTO episode_fingerprints (episode_id, algorithm_version, frame_count, sha256, bytes, created_at)
     VALUES ('e1', 2, 1000, 'abc', 1000, ?)`,
  ).run(now);
  return db;
}

describe('migration 011 classifies the catalogue without losing it', () => {
  it('gives every row the kind its evidence says, and links rules to their rows', () => {
    const db = seededAt010();
    runMigrations(db);
    assert.equal(db.pragma('user_version', { simple: true }), 11);

    const kinds = Object.fromEntries(
      db.prepare('SELECT id, kind, marker_id, anchor_id, hold_reason FROM ad_segments').all().map((row) => [row.id, row]),
    );
    assert.equal(kinds.boundary.kind, 'boundary_words');
    assert.equal(kinds.boundary.marker_id, 'm1');
    assert.equal(kinds.jingle.kind, 'jingle');
    assert.equal(kinds.jingle.anchor_id, 'a1');
    assert.equal(kinds.audio.kind, 'repeated_audio');
    assert.equal(kinds['audio-with-words'].kind, 'repeated_audio', 'words attached later do not change how it was found');
    assert.equal(kinds.diff.kind, 'diff');
    assert.equal(kinds.taught.kind, 'remembered_words', 'a word row with no cues was taught by the owner');
    assert.equal(kinds.repeated.kind, 'repeated_words');
    assert.equal(kinds['once-decided'].kind, 'remembered_words', 'a heard-once read the owner decided about is kept');
    assert.equal(kinds['once-decided'].hold_reason, null);
    assert.equal(kinds['once-undecided'], undefined, 'an undecided heard-once row is removed');
    assert.equal(kinds['orphan-marker'], undefined, 'a boundary row whose boundary is gone is removed');

    const occurrences = db.prepare('SELECT segment_id FROM ad_segment_occurrences').all().map((row) => row.segment_id);
    assert.equal(occurrences.length, 8, 'every kept row kept its occurrence, removed rows took theirs with them');
    assert.deepEqual(db.pragma('foreign_key_check'), [], 'no dangling references');
  });

  it('leaves the published cut and the hold as they were, and dates the hold', () => {
    const db = seededAt010();
    runMigrations(db);
    const e1 = db.prepare('SELECT * FROM episodes WHERE id = ?').get('e1');
    assert.equal(e1.trimmed_filename, 'e1.abcdef012345.mp3');
    assert.equal(e1.publish_hold_since, null);
    const e2 = db.prepare('SELECT * FROM episodes WHERE id = ?').get('e2');
    assert.equal(e2.publish_hold, 'awaiting_corpus');
    assert.equal(e2.publish_hold_since, '2026-09-15T01:00:00.000Z');
  });

  it('removes the row of a rule with the rule, and a restore with its episode', () => {
    const db = seededAt010();
    runMigrations(db);
    db.prepare(
      `INSERT INTO ad_cut_overrides (id, episode_id, segment_id, start_ms, end_ms, created_at)
       VALUES ('o1', 'e1', 'audio', 0, 9000, '2026-09-16T00:00:00.000Z')`,
    ).run();
    assert.throws(
      () => db.prepare(`INSERT INTO ad_cut_overrides (id, episode_id, start_ms, end_ms, created_at) VALUES ('o2', 'e1', 50, 50, 'x')`).run(),
      /CHECK/,
      'an empty range is refused',
    );

    db.prepare('DELETE FROM ad_markers WHERE id = ?').run('m1');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ad_segments WHERE id = 'boundary'").get().n, 0);
    db.prepare('DELETE FROM ad_anchors WHERE id = ?').run('a1');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ad_segments WHERE id = 'jingle'").get().n, 0);

    db.prepare('DELETE FROM ad_segments WHERE id = ?').run('audio');
    assert.equal(db.prepare('SELECT segment_id FROM ad_cut_overrides WHERE id = ?').get('o1').segment_id, null,
      'a restore outlives the row it was made against');
    db.prepare('DELETE FROM episodes WHERE id = ?').run('e1');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ad_cut_overrides').get().n, 0);
  });

  it('still takes the statements 1.8.8 runs, so rolling back is harmless', () => {
    const db = seededAt010();
    runMigrations(db);
    const now = '2026-09-16T00:00:00.000Z';
    // The exact column list upsertSegment inserted in 1.8.8 (ad-detect.js:287-293).
    db.prepare(
      `INSERT INTO ad_segments
         (id, show_id, signature, source, status, auto_approved, hold_reason, duration_ms,
          episode_count, occurrence_count, exemplar_episode_id, exemplar_start_ms, exemplar_end_ms,
          first_seen_at, decided_at, created_at, updated_at, text, raw_text, cue_score, cues, language)
       VALUES ('old', 's1', 'tx:eeeeeeeeeeeeeeeeeeeeeeee', 'transcript', 'candidate', 0, NULL, 5000,
               1, 1, 'e1', 0, 5000, ?, NULL, ?, ?, 'a b c', 'a b c', 0.2, '[]', 'fr')`,
    ).run(now, now, now);
    const read = db
      .prepare(`SELECT s.id FROM ad_segments s WHERE s.source = 'transcript' AND s.signature NOT LIKE 'marker:%'`)
      .all();
    assert.ok(read.some((row) => row.id === 'old'));
    // An old image cannot know the kind; the default is what a 1.9 pass must correct.
    assert.equal(db.prepare("SELECT kind FROM ad_segments WHERE id = 'old'").get().kind, 'repeated_audio');
    db.prepare(`INSERT INTO ad_markers (id, show_id, role, inclusive, text, raw_text, created_at)
                VALUES ('m2', 's1', 'programme_ends', 1, 'a', 'a', ?)`).run(now);
    db.prepare(`DELETE FROM ad_markers WHERE id = 'm2'`).run();
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  });
});
