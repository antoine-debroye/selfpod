import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ALLOWED_BUTTON_LABELS,
  DECISIONS,
  EPISODE_STATES,
  RETIRED_WORDS,
  SETTINGS_BUTTONS,
  STRETCH_STATES,
} from '../../src/lib/adverts-vocabulary.js';

/**
 * The advert pages once had about fifty ways of saying where something stood and twelve
 * button labels for five operations. These counts are the brake: growing the vocabulary
 * has to be a decision taken here, in a test, not a label added in a template.
 */
describe('the words the advert pages may use', () => {
  it('has four states for a stretch', () => {
    assert.deepEqual(Object.keys(STRETCH_STATES), ['cut', 'waiting', 'kept', 'restored']);
    assert.equal(STRETCH_STATES.restored, 'Restored here');
  });

  it('has six states for an episode, each with a pill and a caption', () => {
    assert.deepEqual(Object.keys(EPISODE_STATES), ['cut', 'waiting', 'held', 'listening', 'clean', 'untouched']);
    for (const [key, words] of Object.entries(EPISODE_STATES)) {
      assert.equal(typeof words.pill, 'string', key);
      assert.equal(typeof words.caption, 'string', key);
    }
    assert.equal(EPISODE_STATES.clean.pill, '—');
    assert.equal(EPISODE_STATES.clean.caption, 'Nothing to cut.');
    assert.equal(EPISODE_STATES.untouched.pill, 'as arrived');
  });

  it('has six decisions, all different', () => {
    const labels = Object.values(DECISIONS);
    assert.equal(labels.length, 6);
    assert.equal(new Set(labels).size, 6);
    assert.deepEqual(labels, ['Remove', 'Keep', 'Restore here', 'Restore everywhere and stop', 'Forget', 'Teach']);
  });

  it('allows the decisions and the settings form’s own two buttons, and nothing else', () => {
    assert.deepEqual(SETTINGS_BUTTONS, ['Save', 'Check now']);
    assert.equal(ALLOWED_BUTTON_LABELS.length, 8);
  });

  it('cannot be changed at run time', () => {
    for (const frozen of [STRETCH_STATES, EPISODE_STATES, EPISODE_STATES.cut, DECISIONS, ALLOWED_BUTTON_LABELS, RETIRED_WORDS]) {
      assert.ok(Object.isFrozen(frozen));
    }
  });

  it('never allows a retired label back in', () => {
    for (const word of RETIRED_WORDS) {
      assert.ok(!ALLOWED_BUTTON_LABELS.some((label) => label.includes(word)), word);
    }
  });
});
