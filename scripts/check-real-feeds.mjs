#!/usr/bin/env node
/**
 * Runs the feed parser against live commercial podcast feeds.
 *
 * Deliberately not part of `npm test`. It needs the network, the documents it fetches
 * change under it, and CI has no business depending on someone else's CDN — a test
 * that goes red because the BBC had a bad afternoon teaches people to ignore red.
 *
 * But it is the only check that matters for a format nobody controls. The unit tests
 * pin down behaviour SelfPod chose; this one asks whether that behaviour survives what
 * publishers actually ship. It has already earned its keep: it caught a document-size
 * cap that would have refused The Daily and The Vergecast outright, which no synthetic
 * fixture would ever have suggested.
 *
 * Run it when changing anything in lib/rss-parse.js or lib/entity-decode.js:
 *
 *     node scripts/check-real-feeds.mjs
 *     node scripts/check-real-feeds.mjs https://example.com/your-own-feed.xml
 *
 * Any feed URL given as an argument is checked instead of the defaults, which is the
 * form to use for a private or premium feed you actually subscribe to.
 */

import { REMOTE_FEED_MAX_BYTES } from '../src/constants.js';
import { parseFeed } from '../src/lib/rss-parse.js';

const DEFAULT_FEEDS = [
  { name: 'This American Life', url: 'http://feed.thisamericanlife.org/talpodcast' },
  { name: 'BBC Global News', url: 'https://podcasts.files.bbci.co.uk/p02nq0gn.rss' },
  { name: 'Planet Money (NPR)', url: 'https://feeds.npr.org/510289/podcast.xml' },
  { name: 'The Vergecast', url: 'https://feeds.megaphone.fm/vergecast' },
  { name: 'The Daily (Simplecast)', url: 'https://feeds.simplecast.com/54nAGcIl' },
];

const TIMEOUT_MS = 45_000;

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function check({ name, url }) {
  const label = name ?? new URL(url).host;
  let bytes;
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'SelfPod/dev (feed parser validation)', accept: 'application/rss+xml' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return { label, ok: false, note: `HTTP ${response.status}` };
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    return { label, ok: false, note: `could not be fetched (${error.cause?.code ?? error.name})` };
  }

  const overCap = bytes.length > REMOTE_FEED_MAX_BYTES;

  let feed;
  const started = process.hrtime.bigint();
  try {
    feed = parseFeed(bytes);
  } catch (error) {
    return { label, ok: false, size: bytes.length, note: `REFUSED [${error.code}] ${error.message}` };
  }
  const ms = Number(process.hrtime.bigint() - started) / 1e6;

  // The properties that actually matter downstream. A feed that parses but yields no
  // enclosure URLs is a parse that succeeded and a feature that would silently do
  // nothing, which is the failure mode this whole project exists to remove.
  const problems = [];
  if (!feed.title) problems.push('no channel title');
  if (!feed.items.length) problems.push('no items');
  const withAudio = feed.items.filter((entry) => entry.enclosureUrl).length;
  if (feed.items.length && withAudio === 0) problems.push('no item had an enclosure URL');
  const leaked = feed.items.filter(
    (entry) => entry.description.includes('<') || entry.title.includes('<'),
  ).length;
  if (leaked) problems.push(`${leaked} items still contain markup after stripping`);
  const escaped = feed.items.filter(
    (entry) => /&(amp|lt|gt|quot|#\d+);/.test(entry.title) || /&amp;/.test(entry.enclosureUrl ?? ''),
  ).length;
  if (escaped) problems.push(`${escaped} items still contain undecoded entities`);
  if (overCap) problems.push(`larger than REMOTE_FEED_MAX_BYTES (${mb(REMOTE_FEED_MAX_BYTES)}) — SelfPod would refuse it`);

  return {
    label,
    ok: problems.length === 0,
    size: bytes.length,
    note:
      problems.length === 0
        ? `${feed.items.length} items (${withAudio} with audio) in ${ms.toFixed(0)}ms`
        : problems.join('; '),
  };
}

const requested = process.argv.slice(2);
const feeds = requested.length ? requested.map((url) => ({ url })) : DEFAULT_FEEDS;

console.log(`Checking ${feeds.length} feed${feeds.length === 1 ? '' : 's'}…\n`);

let failures = 0;
for (const feed of feeds) {
  const result = await check(feed);
  if (!result.ok) failures += 1;
  const size = result.size ? mb(result.size).padStart(9) : '        —';
  console.log(`${result.ok ? '  ok ' : 'FAIL '} ${size}  ${result.label.padEnd(24)} ${result.note}`);
}

console.log(
  failures
    ? `\n${failures} feed${failures === 1 ? '' : 's'} did not parse cleanly.`
    : '\nAll feeds parsed cleanly.',
);
process.exit(failures ? 1 : 0);
