import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestServer } from '../helpers/http.js';

/**
 * The access log as a file.
 *
 * Two things make an export worth having and are easy to get wrong. It has to hold
 * everything the filters describe rather than the page of rows that happens to be on
 * screen — otherwise it quietly answers a narrower question than the one asked. And it
 * has to survive an episode title with a comma in it, which is the first thing a real
 * podcast will hand you.
 *
 * The formula guard is the third: a spreadsheet treats a cell beginning `=` or `@` as
 * something to execute, and episode titles are attacker-adjacent text on a server whose
 * whole job is to serve strangers.
 */
describe('exporting the access log', () => {
  let server;
  let show;
  let episode;

  before(async () => {
    server = await createTestServer();
    await server.addAudio('metrics', 'sample.m4a', 'first-episode.m4a');
    await server.scanner.scanAllNow('manual');
    show = server.shows.getBySlug('metrics');
    episode = server.episodes.listByShow(show.id)[0];
    await server.login();
  });

  after(async () => {
    await server.cleanup();
  });

  function clearLog() {
    server.db.prepare('DELETE FROM media_access').run();
  }

  function logRow({ kind = 'download', statusCode = 200, client = 'Overcast', bytes = 1000 } = {}) {
    server.db
      .prepare(
        `INSERT INTO media_access
           (episode_id, show_id, requested_at, kind, status_code, bytes_sent, total_bytes, client)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(episode.id, show.id, new Date().toISOString(), kind, statusCode, bytes, bytes, client);
  }

  function retitle(title) {
    server.db.prepare('UPDATE episodes SET title = ? WHERE id = ?').run(title, episode.id);
  }

  /**
   * A deliberately small RFC 4180 reader.
   *
   * Splitting on commas would pass the very tests that matter least; this understands
   * quoting, so a title containing a comma, a quote or a newline is actually checked.
   */
  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      if (quoted) {
        if (char === '"' && text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else if (char === '"') {
          quoted = false;
        } else {
          field += char;
        }
      } else if (char === '"') {
        quoted = true;
      } else if (char === ',') {
        row.push(field);
        field = '';
      } else if (char === '\r' && text[i + 1] === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
        i += 1;
      } else {
        field += char;
      }
    }
    if (field || row.length) {
      row.push(field);
      rows.push(row);
    }
    return rows;
  }

  async function download(query = '') {
    const response = await server.get(`/stats/access-log.csv${query}`);
    assert.equal(response.statusCode, 200, `the export at ${query || '/'} responds`);
    // The BOM is there so a spreadsheet reads accented titles as UTF-8.
    const body = response.body.replace(/^﻿/, '');
    return { response, rows: parseCsv(body), body };
  }

  it('sends a CSV attachment named after the active filters', async () => {
    clearLog();
    logRow();
    const { response } = await download('?showId=metrics&failuresOnly=1&range=7d');
    assert.match(response.headers['content-type'], /text\/csv/, 'it is served as CSV');
    const disposition = response.headers['content-disposition'];
    assert.match(disposition, /attachment/, 'it downloads rather than rendering');
    assert.match(disposition, /metrics/, 'the filename names the show that was filtered to');
    assert.match(disposition, /failures/, 'and says it holds only failures');
  });

  it('exports every matching row, not only the page on screen', async () => {
    clearLog();
    for (let i = 0; i < 45; i += 1) logRow();
    const { rows } = await download();
    // The page shows 40 at a time; the export is what the filters describe.
    assert.equal(rows.length, 46, '45 rows plus one header line');
  });

  it('changes with the filter', async () => {
    clearLog();
    logRow({ statusCode: 200 });
    logRow({ statusCode: 404 });

    const everything = await download();
    const failures = await download('?failuresOnly=1');
    assert.equal(everything.rows.length, 3, 'both rows and a header');
    assert.equal(failures.rows.length, 2, 'only the failure and a header');
    assert.equal(failures.rows[1][5], '404', 'and it is the one that failed');
  });

  it('honours a request-type filter', async () => {
    clearLog();
    logRow({ kind: 'download' });
    logRow({ kind: 'stream' });
    const { rows } = await download('?kind=stream');
    assert.equal(rows.length, 2, 'one row and a header');
    assert.equal(rows[1][4], 'stream', 'and it is the stream');
  });

  it('survives a title holding a comma, a quote and a newline', async () => {
    clearLog();
    const awkward = 'Episode 4: "Hard, isn\'t it?"\nA second line';
    retitle(awkward);
    logRow();

    const { rows } = await download();
    assert.equal(rows.length, 2, 'the newline inside a quoted field did not start a new row');
    assert.equal(rows[1][2], awkward, 'the title survives the round trip exactly');
  });

  it('exports a title starting with = as text a spreadsheet will not run', async () => {
    clearLog();
    retitle('=SUM(A1:A9)');
    logRow();

    const { rows } = await download();
    assert.equal(
      rows[1][2],
      "'=SUM(A1:A9)",
      'the leading apostrophe is what stops a spreadsheet evaluating the cell',
    );
  });

  it('names the columns in its first line', async () => {
    clearLog();
    retitle('First episode');
    logRow();
    const { rows } = await download();
    assert.ok(rows[0].includes('requested_at_utc'), 'the timestamp column says which zone it is in');
    assert.ok(rows[0].includes('episode'), 'and the episode is named');
    assert.ok(rows[0].includes('app'), 'and the app family');
  });

  it('sends an unauthenticated visitor to sign in rather than handing over a file', async () => {
    const response = await server.app.inject({ url: '/stats/access-log.csv' });
    assert.equal(response.statusCode, 303, 'it redirects rather than answering');
    assert.match(response.headers.location, /^\/login\b/, 'to the sign-in page');
    assert.ok(
      !String(response.headers['content-type'] ?? '').includes('csv'),
      'and no part of the log is written into a download',
    );
  });
});
