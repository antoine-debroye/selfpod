#!/usr/bin/env node
/**
 * Runs the spoken-advert pipeline against real episodes of a real feed.
 *
 * Deliberately not part of `npm test`, for the reasons check-real-feeds.mjs gives, and
 * for one more: synthetic fixtures agreed with a wrong assumption once and hid that a
 * whole detector found nothing on real audio. This is the check that a transcript of
 * a real French or English opening contains the sponsor read, that the same read is
 * found across episodes, that the cues fire on it, and that a boundary the owner would
 * teach is heard where they say it is.
 *
 *     node scripts/check-real-adverts.mjs <feed-url> [--episodes 4] [--marker "Vous écoutez RMC"]
 *         [--head 300] [--tail 240] [--whisper /opt/homebrew/bin/whisper-cli]
 *         [--model ~/models/ggml-base-q5_1.bin] [--keep DIR]
 *
 * It calls the same library code the service does — decoder, WAV writer, runner,
 * hallucination filter, normaliser, matcher, cue scorer, edge snapper — and prints
 * what each step produced, with the measured real-time factor.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseFeed } from '../src/lib/rss-parse.js';
import { decodeToMono } from '../src/lib/decode-audio.js';
import { frameProfile } from '../src/lib/mp3-frames.js';
import { openWavWriter } from '../src/lib/wav.js';
import { runWhisper } from '../src/lib/whisper-runner.js';
import { filterHallucinations, flattenWords, rawTextOf, wordsFromWhisper } from '../src/lib/transcript.js';
import { normaliseText, normaliseTokens } from '../src/lib/text-normalise.js';
import { findRepeatedText, locatePhrase } from '../src/lib/repeated-text.js';
import { scoreAdvertCues, describeCues } from '../src/lib/advert-cues.js';
import { createEnvelopeBuilder, snapToDip } from '../src/lib/snap-edges.js';
import { CUE_OFFER_ALONE, CUE_STRONG } from '../src/constants.js';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
const feedUrl = args.find((arg) => /^https?:/.test(arg));
if (!feedUrl) {
  console.error('Usage: node scripts/check-real-adverts.mjs <feed-url> [--episodes 4] [--marker "words"]');
  process.exit(2);
}
const count = Number(option('episodes', 4));
const headMs = Number(option('head', 300)) * 1000;
const tailMs = Number(option('tail', 240)) * 1000;
const binary = option('whisper', process.env.WHISPER_CLI ?? 'whisper-cli');
const model = option('model', process.env.WHISPER_MODEL);
const marker = option('marker', null);
const keep = option('keep', null);
if (!model) {
  console.error('Say where the model is: --model path/to/ggml-base-q5_1.bin (or WHISPER_MODEL).');
  process.exit(2);
}

const clock = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}.${String(Math.floor((ms % 1000) / 100))}`;

const dir = keep ?? (await mkdtemp(join(tmpdir(), 'selfpod-adverts-')));
await mkdir(dir, { recursive: true });
console.log(`Working in ${dir}\n`);

const feed = parseFeed(Buffer.from(await (await fetch(feedUrl)).arrayBuffer()));
const items = feed.items.filter((item) => item.enclosureUrl).slice(0, count);
console.log(`${feed.title}: taking ${items.length} of ${feed.items.length} episodes\n`);

const episodes = [];
for (const [index, item] of items.entries()) {
  const path = join(dir, `ep${index + 1}.mp3`);
  let bytes;
  try {
    bytes = await readFile(path);
  } catch {
    process.stdout.write(`Downloading ${item.title}… `);
    bytes = Buffer.from(await (await fetch(item.enclosureUrl)).arrayBuffer());
    await writeFile(path, bytes);
    console.log(`${(bytes.length / 1e6).toFixed(1)} MB`);
  }
  const profile = frameProfile(bytes);
  if (!profile) {
    console.log(`  ${item.title}: not an MP3 SelfPod can read`);
    continue;
  }
  const windows =
    headMs + tailMs >= profile.durationMs
      ? [{ kind: 'whole', fromMs: 0, toMs: profile.durationMs }]
      : [
          { kind: 'head', fromMs: 0, toMs: headMs },
          { kind: 'tail', fromMs: profile.durationMs - tailMs, toMs: profile.durationMs },
        ];
  const heard = [];
  let audioMs = 0;
  let workMs = 0;
  for (const [w, window] of windows.entries()) {
    const wav = join(dir, `ep${index + 1}-${window.kind}.wav`);
    const writer = openWavWriter(wav, { sampleRate: 16000 });
    const envelope = createEnvelopeBuilder(16000);
    const first = profile.frames.findIndex((_, i) => i * (profile.frames[0].samplesPerFrame / profile.sampleRate) * 1000 >= window.fromMs);
    const last = window.toMs >= profile.durationMs ? profile.frames.length : profile.frames.findIndex((_, i) => i * (profile.frames[0].samplesPerFrame / profile.sampleRate) * 1000 >= window.toMs);
    await decodeToMono(bytes, profile.frames.slice(Math.max(0, first), last), (samples) => {
      writer.write(samples);
      envelope.push(samples);
    }, { targetRate: 16000, resample: 'average' });
    writer.close();
    const started = Date.now();
    const { json } = await runWhisper({ binary, model, wavPath: wav, outputPrefix: join(dir, `ep${index + 1}-${window.kind}`), threads: 2 });
    workMs += Date.now() - started;
    audioMs += window.toMs - window.fromMs;
    const { language, sentences } = wordsFromWhisper(json, { offsetMs: window.fromMs, window: w });
    heard.push({ ...window, language, sentences: filterHallucinations(sentences), envelope: envelope.finish() });
    if (!keep) await rm(wav, { force: true });
  }
  const words = heard.flatMap((window) => flattenWords(window.sentences));
  episodes.push({ id: `ep${index + 1}`, title: item.title, durationMs: profile.durationMs, windows: heard, words, tokens: normaliseTokens(words), rate: audioMs / Math.max(1, workMs) });
  console.log(`\n== ${item.title} (${clock(profile.durationMs)}, ${heard[0]?.language ?? '?'}, ${(audioMs / Math.max(1, workMs)).toFixed(1)}× real time)`);
  for (const window of heard) {
    console.log(`-- ${window.kind} ${clock(window.fromMs)}–${clock(window.toMs)}`);
    for (const sentence of window.sentences) {
      const scored = scoreAdvertCues(normaliseTokens(sentence.words), { rawText: sentence.text });
      console.log(`   [${clock(sentence.startMs)}] ${scored.raw ? `(${scored.cues.map((c) => c.id).join(',')}) ` : ''}${sentence.text}`);
    }
  }
}

console.log('\n== The same words across episodes');
const found = findRepeatedText(episodes.map((episode) => ({ id: episode.id, tokens: episode.tokens })));
if (!found.length) console.log('   nothing — if these episodes share a read, that is the bug to chase');
for (const segment of found) {
  const exemplar = episodes.find((episode) => episode.id === segment.exemplar.episodeId);
  const tokens = exemplar.tokens.slice(segment.exemplar.start, segment.exemplar.end + 1);
  const words = exemplar.words.slice(tokens[0].word, tokens[tokens.length - 1].word + 1);
  const cues = scoreAdvertCues(tokens, { rawText: rawTextOf(words) });
  const verdict = cues.score >= CUE_STRONG ? 'sounds like a sponsor read' : 'no sponsor cues — an intro, a tag, or the programme';
  console.log(`\n - ${segment.episodeCount} episodes, ${(segment.durationMs / 1000).toFixed(1)} s, cue score ${cues.score.toFixed(2)}: ${verdict}`);
  if (cues.cues.length) console.log(`   it ${describeCues(cues.cues)}`);
  for (const occurrence of segment.occurrences) {
    const episode = episodes.find((candidate) => candidate.id === occurrence.episodeId);
    const window = episode.windows.find((candidate) => occurrence.startMs >= candidate.fromMs && occurrence.startMs <= candidate.toMs);
    const start = window ? snapToDip(occurrence.startMs, window.envelope, { fromMs: window.fromMs }) : occurrence.startMs;
    const end = window ? snapToDip(occurrence.endMs, window.envelope, { fromMs: window.fromMs }) : occurrence.endMs;
    console.log(`   ${occurrence.episodeId}: words ${clock(occurrence.startMs)}–${clock(occurrence.endMs)}, cut on pauses ${clock(start)}–${clock(end)}, similarity ${occurrence.similarity.toFixed(2)}`);
  }
  console.log(`   “${rawTextOf(words).slice(0, 200)}${words.length > 40 ? '…' : ''}”`);
}

console.log('\n== Sponsor reads heard once');
for (const episode of episodes) {
  for (const window of episode.windows) {
    for (const sentence of window.sentences) {
      const scored = scoreAdvertCues(normaliseTokens(sentence.words), { rawText: sentence.text });
      if (scored.score >= CUE_OFFER_ALONE) console.log(`   ${episode.id} [${clock(sentence.startMs)}] ${scored.cues.map((c) => c.id).join(',')}: ${sentence.text}`);
    }
  }
}

if (marker) {
  console.log(`\n== Boundary: "${marker}"`);
  const phrase = normaliseText(marker);
  for (const episode of episodes) {
    const hit = locatePhrase(episode.tokens, phrase);
    if (!hit) {
      console.log(`   ${episode.id}: NOT HEARD`);
      continue;
    }
    const window = episode.windows.find((candidate) => hit.startMs >= candidate.fromMs && hit.startMs <= candidate.toMs);
    const cutEnd = window ? snapToDip(hit.startMs, window.envelope, { fromMs: window.fromMs, direction: 'before' }) : hit.startMs;
    console.log(`   ${episode.id}: heard at ${clock(hit.startMs)}–${clock(hit.endMs)} (${hit.errors} ${hit.errors === 1 ? 'error' : 'errors'}) → cut 0:00.0–${clock(cutEnd)}${cutEnd < 2000 ? ' (nothing before it)' : ''}`);
  }
}

const rates = episodes.map((episode) => episode.rate);
if (rates.length) console.log(`\nReal-time factor: ${(rates.reduce((a, b) => a + b, 0) / rates.length).toFixed(1)}× on this machine, 2 threads.`);
if (!keep) await rm(dir, { recursive: true, force: true }).catch(() => {});
