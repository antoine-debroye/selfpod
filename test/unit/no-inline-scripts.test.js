import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const VIEWS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'web', 'views');

/**
 * The content security policy this app sends is `script-src 'self'` with no
 * `unsafe-inline`, and `plugins/security-headers.js` justifies that by asserting every
 * script is an external file. This test is what makes that assertion true rather than
 * aspirational.
 *
 * It exists because the assertion was false in 1.6.0. Two toggles in Settings carried
 * `onchange="this.form.requestSubmit()"`, the browser refused to run them, and it
 * refused *silently* — no console error, no network request. The switch animated and
 * sprang back. One of those toggles was the master switch for following podcast feeds,
 * so the whole feature could not be turned on, and nothing anywhere said why.
 *
 * That is the shape of failure worth a structural test: no exception, no log line, and
 * a feature that simply does not exist.
 */
async function eachTemplate(directory, visit) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await eachTemplate(path, visit);
    else if (entry.name.endsWith('.eta')) await visit(path, await readFile(path, 'utf8'));
  }
}

describe('the content security policy this app promises to keep', () => {
  it('finds no inline event handler in any template', async () => {
    const offenders = [];
    await eachTemplate(VIEWS, (path, source) => {
      source.split('\n').forEach((line, index) => {
        // `on…="…"` on an element. Deliberately not matched inside an Eta expression,
        // where "on" can begin an ordinary word.
        const match = line.match(/\son[a-z]+\s*=\s*["']/i);
        if (match) offenders.push(`${path.slice(path.indexOf('views'))}:${index + 1} ${match[0].trim()}`);
      });
    });

    assert.deepEqual(
      offenders,
      [],
      `inline handlers are silently refused by script-src 'self':\n  ${offenders.join('\n  ')}`,
    );
  });

  it('finds no inline <script> body in any template', async () => {
    // A `<script>` with content is refused the same way. The one script tag this app
    // has is `type="application/json"`, which is data rather than script and runs
    // nothing — the policy allows it and so does this.
    const offenders = [];
    await eachTemplate(VIEWS, (path, source) => {
      const tags = source.match(/<script\b[\s\S]*?<\/script>/gi) ?? [];
      for (const tag of tags) {
        // A tag with a `src` loads an external file, which is what the policy allows.
        // Matched on the whole tag rather than a parsed opening: an Eta expression in
        // the attribute contains a `>`, so anything that splits on the first one reads
        // half the attribute as the body — which is how this test first accused every
        // external script in the app of being inline.
        if (/\ssrc\s*=/i.test(tag)) continue;
        if (/type\s*=\s*["']application\/json["']/i.test(tag)) continue;
        if (tag.replace(/<script\b[^>]*>|<\/script>/gi, '').trim() === '') continue;
        offenders.push(`${path.slice(path.indexOf('views'))}: ${tag.slice(0, 60)}`);
      }
    });

    assert.deepEqual(offenders, [], `inline script bodies are refused:\n  ${offenders.join('\n  ')}`);
  });

  it('still has the switches that need to save themselves marked to do so', async () => {
    // The positive control. Removing the inline handlers without putting the behaviour
    // anywhere would satisfy both checks above and leave the toggles just as dead.
    const settings = await readFile(join(VIEWS, 'pages', 'settings.eta'), 'utf8');
    const marked = settings.match(/data-submit-on-change/g) ?? [];
    assert.equal(marked.length, 2, 'both Settings toggles should save the moment they are flipped');

    const app = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'web', 'public', 'js', 'app.js'),
      'utf8',
    );
    assert.match(app, /data-submit-on-change/, 'nothing acts on the attribute');
    assert.match(app, /requestSubmit\(\)/, 'the attribute is read but never submits');
  });

  it('still has the cut bar and the range picker wired to the script that drives them', async () => {
    // The same failure as the toggles, one feature on: a ▶ that only follows its link
    // and a bar that ignores a tap both look fine and pass every server-side test.
    const partials = join(VIEWS, 'partials');
    const bar = await readFile(join(partials, 'cut-bar.eta'), 'utf8');
    const stretch = await readFile(join(partials, 'cut-stretch.eta'), 'utf8');
    const teach = await readFile(join(partials, 'teach-range.eta'), 'utf8');
    assert.match(bar, /data-cutbar\b/);
    assert.match(bar, /data-cut-audio/);
    assert.match(bar, /data-cutbar-pick\b/);
    assert.match(bar + stretch, /data-play-from=/, 'the ▶ does not say where to play from');
    assert.match(stretch, /data-play-to=/);
    assert.match(teach, /data-cutbar-pick-form/, 'the bar has no form to fill');
    assert.match(teach, /data-range-from/);
    assert.match(teach, /data-range-to/);
    assert.match(teach, /data-pick-from-player/);

    const app = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'web', 'public', 'js', 'app.js'),
      'utf8',
    );
    for (const hook of ['[data-play-from]', '[data-cutbar]', 'audio[data-cut-audio]', '[data-cutbar-pick]', '[data-cutbar-pick-form]', '[data-range-from]', '[data-range-to]', '[data-pick-from-player]', '[data-tx-scope]']) {
      assert.ok(app.includes(hook), `app.js never looks for ${hook}`);
    }
    assert.match(app, /\.play\(\)/, 'nothing ever plays the stretch');
    assert.match(app, /currentTime/, 'nothing moves the player to the stretch');
  });
});
