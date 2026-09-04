import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createEnvelopeBuilder, decodeEnvelope, encodeEnvelope, snapToDip } from '../../src/lib/snap-edges.js';

/** An envelope that is loud (200) except for a dip of `depth` over [from, to) hops. */
function withDip(length, from, to, depth = 40) {
  const envelope = new Uint8Array(length).fill(200);
  for (let k = from; k < to; k += 1) envelope[k] = depth;
  return envelope;
}

describe('snapping a cut to a pause', () => {
  it('moves an edge onto a nearby dip', () => {
    // Dip 300 ms before the proposed edge at 5.00 s: hops 462..478 (4.62–4.78 s).
    const envelope = withDip(1000, 462, 478);
    const snapped = snapToDip(5000, envelope, { fromMs: 0 });
    assert.ok(snapped >= 4620 && snapped <= 4780, `snapped to ${snapped}`);
  });

  it('prefers the nearest quiet moment over a deeper one further away', () => {
    const envelope = withDip(1000, 440, 450, 10); // deep, 500 ms away
    for (let k = 490; k < 496; k += 1) envelope[k] = 60; // shallow, right here
    // 60 is 15 dB louder than 10, so the deep one is "the" pause and the shallow one
    // is not. The nearest point of the deep pause wins — its inner edge, less the
    // smoothing that trims a pause's edges.
    const snapped = snapToDip(5000, envelope, { fromMs: 0 });
    assert.ok(snapped >= 4420 && snapped <= 4480, `snapped to ${snapped}`);
  });

  it('does not look further than the search window', () => {
    const envelope = withDip(1000, 100, 110);
    assert.equal(snapToDip(5000, envelope, { fromMs: 0, searchMs: 600 }), 5000);
  });

  it('honours the envelope origin', () => {
    const envelope = withDip(200, 20, 30);
    // envelope[0] is at 60.00 s; the dip is at 60.20–60.30.
    const snapped = snapToDip(60500, envelope, { fromMs: 60000 });
    assert.ok(snapped >= 60200 && snapped <= 60300, `snapped to ${snapped}`);
  });

  it('leaves the edge alone with no envelope', () => {
    assert.equal(snapToDip(1234, null, {}), 1234);
    assert.equal(snapToDip(1234, new Uint8Array(0), {}), 1234);
  });
});

describe('building an envelope', () => {
  it('measures loudness per hop and survives the round trip', () => {
    const builder = createEnvelopeBuilder(16000, { hopMs: 10 });
    const loud = new Float64Array(160).fill(0.5);
    const quiet = new Float64Array(160).fill(0.001);
    builder.push(loud);
    builder.push(quiet);
    builder.push(loud.subarray(0, 80)); // a partial hop is flushed on finish
    const envelope = builder.finish();
    assert.equal(envelope.length, 3);
    assert.ok(envelope[0] > envelope[1] + 100, `${envelope[0]} vs ${envelope[1]}`);
    assert.deepEqual(decodeEnvelope(encodeEnvelope(envelope)), envelope);
  });
});

describe('snapping in one direction only', () => {
  it('never moves the end of a pre-roll into the programme', () => {
    const envelope = withDip(1000, 505, 515); // a pause just *after* the boundary word starts
    for (let k = 480; k < 486; k += 1) envelope[k] = 60; // and a lesser dip before it
    const both = snapToDip(5000, envelope, { fromMs: 0 });
    const before = snapToDip(5000, envelope, { fromMs: 0, direction: 'before' });
    assert.ok(both > 5000, 'the unconstrained snap should prefer the deeper pause after');
    assert.ok(before <= 5000, `moved into the programme: ${before}`);
  });
});
