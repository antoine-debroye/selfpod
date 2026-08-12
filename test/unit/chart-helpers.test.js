import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createViewHelpers } from '../../src/web/lib/view-helpers.js';
import { changeFrom } from '../../src/services/stats.js';

/**
 * Chart geometry.
 *
 * These helpers turn counts into bar heights, and the ways that goes wrong are all
 * quiet ones: a busy day and a quiet day drawn the same height, a day with a single
 * request rounding to nothing and vanishing, or a "+100%" invented out of a period that
 * had no data at all. None of those throw — they just tell the reader something untrue,
 * which is why they are worth a test each.
 */
const helpers = createViewHelpers({ config: { timeZone: 'Europe/London' } });

const SERIES = [
  { key: 'downloads', label: 'Downloads', tone: 'accent' },
  { key: 'streams', label: 'Streams', tone: 'teal' },
];

function bucket(label, downloads, streams) {
  return { key: label, label, downloads, streams };
}

describe('dailySeries', () => {
  it('scales every column against the tallest, which fills the plot exactly', () => {
    const chart = helpers.dailySeries([bucket('Mon', 10, 0), bucket('Tue', 5, 0)], { series: SERIES });
    assert.equal(chart.max, 10, 'the tallest stack sets the scale');
    assert.equal(chart.columns[0].segments[0].pct, 100, 'the busiest column reaches the top');
    assert.equal(chart.columns[1].segments[0].pct, 50, 'and half the traffic is half the height');
  });

  it('stacks the series so the column is the total', () => {
    const chart = helpers.dailySeries([bucket('Mon', 6, 4)], { series: SERIES });
    assert.equal(chart.columns[0].total, 10, 'downloads and streams together');
    const heights = chart.columns[0].segments.map((seg) => seg.pct);
    assert.equal(heights[0] + heights[1], 100, 'the two segments fill the column between them');
  });

  it('keeps a quiet day as a real zero rather than closing the gap', () => {
    const chart = helpers.dailySeries([bucket('Mon', 8, 0), bucket('Tue', 0, 0), bucket('Wed', 4, 0)], {
      series: SERIES,
    });
    assert.equal(chart.columns.length, 3, 'the quiet day still has a column');
    assert.equal(chart.columns[1].total, 0, 'and it is honestly empty');
    assert.equal(chart.columns[1].segments[0].value, 0, 'so nothing is drawn for it');
  });

  it('reports emptiness rather than dividing by zero', () => {
    const chart = helpers.dailySeries([bucket('Mon', 0, 0), bucket('Tue', 0, 0)], { series: SERIES });
    assert.equal(chart.empty, true, 'a period with no traffic says so');
    assert.equal(chart.columns[0].segments[0].pct, 0, 'and no height is NaN');
  });

  it('names the busiest period in the caption', () => {
    const chart = helpers.dailySeries([bucket('Mon', 3, 0), bucket('Tue', 9, 0), bucket('Wed', 1, 0)], {
      series: SERIES,
    });
    assert.equal(chart.peak.label, 'Tue', 'the peak is the tallest column');
    assert.equal(chart.peak.total, 9, 'with its real total');
  });

  it('gives three axis ticks at most, however long the period', () => {
    const rows = Array.from({ length: 90 }, (_, i) => bucket(`d${i}`, i, 0));
    const chart = helpers.dailySeries(rows, { series: SERIES });
    assert.equal(chart.ticks.length, 3, 'ninety labels would collide on a phone');
    assert.equal(chart.ticks[0].label, 'd0', 'the first period is labelled');
    assert.equal(chart.ticks[2].label, 'd89', 'and so is the last');
  });

  it('puts a tooltip on every column naming both series', () => {
    const chart = helpers.dailySeries([bucket('Mon', 6, 4)], { series: SERIES });
    assert.match(chart.columns[0].title, /Mon/, 'the tooltip says which period');
    assert.match(chart.columns[0].title, /6 downloads/, 'and how many downloads');
    assert.match(chart.columns[0].title, /4 streams/, 'and how many streams');
  });
});

describe('shareBars', () => {
  const rows = [
    { client: 'Pocket Casts', n: 60 },
    { client: 'Overcast', n: 30 },
    { client: 'Castro', n: 10 },
  ];

  it('measures bar length against the biggest and share against the whole', () => {
    const bars = helpers.shareBars(rows, { limit: 8 });
    assert.equal(bars.rows[0].pct, 100, 'the biggest bar fills its track');
    assert.equal(bars.rows[0].share, 60, 'but it is 60% of all requests');
    assert.equal(bars.rows[1].pct, 50, 'half the biggest is half the bar');
  });

  it('sums everything past the limit rather than drawing slivers', () => {
    const bars = helpers.shareBars(rows, { limit: 2 });
    assert.equal(bars.rows.length, 2, 'only the top two are drawn');
    assert.equal(bars.other, 10, 'and the rest is counted, not dropped');
    assert.equal(bars.total, 100, 'the total still covers everything');
  });

  it('marks Unknown and Other as the absence of a classification', () => {
    const bars = helpers.shareBars([{ client: 'Unknown', n: 5 }, { client: 'Pocket Casts', n: 5 }]);
    const unknown = bars.rows.find((row) => row.label === 'Unknown');
    const app = bars.rows.find((row) => row.label === 'Pocket Casts');
    assert.equal(unknown.vague, true, 'Unknown is not an app');
    assert.equal(app.vague, false, 'a real app is');
  });

  it('handles having nothing to draw', () => {
    const bars = helpers.shareBars([]);
    assert.deepEqual(bars.rows, [], 'no rows');
    assert.equal(bars.total, 0, 'and no division by zero');
  });
});

describe('changeLine', () => {
  it('reads a rise as good news on downloads and bad news on failures', () => {
    const rise = changeFrom(12, 10);
    assert.equal(helpers.changeLine(rise, { higherIsBetter: true }).tone, 'good', 'more downloads is good');
    assert.equal(helpers.changeLine(rise, { higherIsBetter: false }).tone, 'bad', 'more failures is not');
  });

  it('reads a fall in failures as good news', () => {
    const fall = changeFrom(2, 10);
    assert.equal(helpers.changeLine(fall, { higherIsBetter: false }).tone, 'good', 'fewer failures is good');
    assert.equal(helpers.changeLine(fall, { higherIsBetter: true }).tone, 'bad', 'fewer downloads is not');
  });

  it('states the absolute change when there is no percentage to state', () => {
    // A rise from zero has no percentage — see changeFrom in services/stats.js.
    const line = helpers.changeLine(changeFrom(4, 0), { periodLabel: 'the previous 30 days' });
    assert.match(line.label, /\+4\b/, 'it says how many more, since it cannot say how much more');
    assert.ok(!line.label.includes('%'), 'and invents no percentage');
  });

  it('says nothing rather than something wrong when there is no earlier period', () => {
    assert.equal(helpers.changeLine(null), null, 'all time has nothing to compare against');
  });

  it('calls no change no change', () => {
    const line = helpers.changeLine(changeFrom(7, 7), { periodLabel: 'the previous 7 days' });
    assert.equal(line.tone, 'flat', 'flat is neither good nor bad');
    assert.equal(line.label, 'no change vs the previous 7 days', 'and says so plainly');
  });
});

describe('episodeEventBadge', () => {
  it('gives each timeline event its own dot and words', () => {
    assert.deepEqual(helpers.episodeEventBadge('added'), { cls: 'badge-ok', label: 'Added' });
    assert.deepEqual(helpers.episodeEventBadge('missing'), { cls: 'badge-warn', label: 'Went missing' });
    assert.deepEqual(helpers.episodeEventBadge('expired'), { cls: 'badge-err', label: 'Expired' });
    assert.deepEqual(helpers.episodeEventBadge('removed'), { cls: 'badge-mute', label: 'Removed' });
  });
});
