import { existsSync } from 'node:fs';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FINGERPRINTABLE_EXTENSIONS,
  MAX_BACKFILL_PER_RUN,
  MAX_PIPELINE_FILE_BYTES,
  TRANSCRIBE_MODES,
  TRANSCRIPT_VERSION,
} from '../constants.js';
import { createAudioWorker } from '../lib/audio-search.js';
import { framesFromTable } from '../lib/audio-tasks.js';
import { nowIso } from '../lib/dates.js';
import { EVENTS } from '../lib/events.js';
import { frameIndexToMs, framesForMs } from '../lib/mp3-frames.js';
import { gateEpisodeFile } from '../lib/pipeline-file.js';
import { decodeEnvelope, encodeEnvelope } from '../lib/snap-edges.js';
import { newId } from '../lib/tokens.js';
import { filterHallucinations, wordsFromWhisper } from '../lib/transcript.js';
import { WhisperError, deviceFromLog, runWhisper, timeoutFor } from '../lib/whisper-runner.js';
import { pickWhisperBinary } from '../lib/cpu-features.js';

/**
 * Hearing the words in an episode (spec §19.6).
 *
 * Decodes the opening and closing minutes of an MP3 — or all of it, if asked — to
 * 16 kHz mono, hands that to whisper.cpp in a child process, and keeps what came back
 * under /data/.tx next to the fingerprints. Everything about *what* the words mean
 * lives in ad-detect.js; this only hears them.
 *
 * The decoding happens in the audio worker, and only the window's own bytes are read
 * for it: an hour-long episode is not held in memory on the thread serving listeners
 * for the minutes the recogniser spends on its first five.
 *
 * ## Never holding the feed for a recogniser that is not there
 *
 * The failure this is built against is quiet: an episode held "until SelfPod has
 * listened to it" on a box where the recogniser cannot run, for ever, with a page that
 * says it is about to. So the recogniser is proved at boot on a one-second file and
 * declared unavailable — loudly, in the health banner — when that fails; an episode
 * that fails three times is left alone and counted; and three failures in a row of any
 * kind trip a breaker that makes the whole stage unavailable for six hours. Whatever
 * is unavailable is not waited for: the hold reads `available()`.
 */
const SAMPLE_RATE = 16_000;
const PRIMER_FRAMES = 8;
const MAX_ATTEMPTS = 3;
const RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
const BREAKER_FAILURES = 3;
const BREAKER_OPEN_MS = 6 * 60 * 60 * 1000;
const DEFAULT_DIR = '/app/whisper';
const DEFAULT_MODEL = 'ggml-base-q5_1.bin';
const SMOKE_WAV = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docker', 'fixtures', 'whisper-smoke.wav');

export function createTranscriber({ db, config, events, logger, health, shows, episodes, runner = runWhisper, audio = null }) {
  // Shared with the fingerprinter when the caller passes one, so there is one worker
  // for the whole pipeline rather than one per stage.
  const audioWorker = audio ?? createAudioWorker({ logger });
  const selectRow = db.prepare('SELECT * FROM episode_transcripts WHERE episode_id = ?');
  const selectFingerprint = db.prepare('SELECT sha256, bytes FROM episode_fingerprints WHERE episode_id = ?');
  const upsertRow = db.prepare(
    `INSERT INTO episode_transcripts
       (episode_id, algorithm_version, model, scope, head_ms, tail_ms, language, status, failure,
        attempts, attempted_at, sha256, bytes, word_count, cpu_ms, created_at)
     VALUES (@episode_id, @algorithm_version, @model, @scope, @head_ms, @tail_ms, @language, @status, @failure,
        @attempts, @attempted_at, @sha256, @bytes, @word_count, @cpu_ms, @created_at)
     ON CONFLICT(episode_id) DO UPDATE SET
       algorithm_version = excluded.algorithm_version, model = excluded.model, scope = excluded.scope,
       head_ms = excluded.head_ms, tail_ms = excluded.tail_ms, language = excluded.language,
       status = excluded.status, failure = excluded.failure, attempts = excluded.attempts,
       attempted_at = excluded.attempted_at, sha256 = excluded.sha256, bytes = excluded.bytes,
       word_count = excluded.word_count, cpu_ms = excluded.cpu_ms, created_at = excluded.created_at`,
  );

  /*
   * The binaries to try, best first. The GPU image ships `whisper-cli-cuda` beside the
   * CPU builds; it is tried first and kept only if it actually used the GPU. A binary
   * the operator named is the only candidate: they chose it.
   */
  const whisperDir = config.whisperDir ?? DEFAULT_DIR;
  const cudaBinary = join(whisperDir, 'whisper-cli-cuda');
  const cpuBinary = pickWhisperBinary(whisperDir);
  const candidates = config.whisperBinary
    ? [config.whisperBinary]
    : existsSync(cudaBinary) ? [cudaBinary, cpuBinary] : [cpuBinary];
  let binaryPath = candidates[0];
  /** 'gpu' | 'cpu' | null (not known yet), and the device whisper named. */
  let accelerator = null;
  let device = null;
  // WHISPER_MODEL is a path, or one of the names the image ships: `base` or `small`.
  const modelPath = /^[a-z0-9.-]+$/i.test(config.whisperModel ?? '')
    ? join(DEFAULT_DIR, `ggml-${config.whisperModel.replace(/^ggml-|\.bin$/g, '')}${/-q\d/.test(config.whisperModel) ? '' : '-q5_1'}.bin`)
    : (config.whisperModel ?? join(DEFAULT_DIR, DEFAULT_MODEL));
  const threads = config.whisperThreads ?? 2;
  /** What goes in the `model` column, and what a stored transcript is judged against. */
  const modelName = modelPath.slice(modelPath.lastIndexOf('/') + 1);

  /** 'unknown' | 'ready' | 'missing' | 'failing' */
  let state = 'unknown';
  let openUntil = 0;
  let consecutiveFailures = 0;
  /** Measured, so the page can say what an episode costs on this machine. */
  let lastRate = null;
  let active = null;

  function transcriptPath(showId, episodeId) {
    return join(config.transcriptDir, showId, `${episodeId}.${TRANSCRIPT_VERSION}.json`);
  }

  function isMp3(episode) {
    const at = episode.filename.lastIndexOf('.');
    return at >= 0 && FINGERPRINTABLE_EXTENSIONS.includes(episode.filename.slice(at).toLowerCase());
  }

  function setUnavailable(reason, detail) {
    state = reason;
    const configured = Boolean(config.whisperBinary);
    if (reason === 'missing') {
      health?.set('whisper_unavailable', {
        // A dev machine with nothing configured is not a fault; a NAS image that lost
        // its binary is.
        level: configured || process.platform === 'linux' ? 'warn' : 'info',
        message: 'SelfPod cannot listen for spoken adverts: the speech recogniser is not available.',
        detail: `${detail} Adverts are still found by comparing episodes by sound, and episodes are published as before — but a read the host performs live will get through. Set WHISPER_CLI and WHISPER_MODEL to a working whisper.cpp build, or use the SelfPod image, which ships one.`,
      });
    } else {
      health?.set('whisper_failing', {
        level: 'warn',
        message: 'SelfPod has stopped listening for spoken adverts for a few hours: the speech recogniser keeps failing.',
        detail: `${detail} Episodes are published as they arrive meanwhile. If this keeps happening, shorten “Where to listen” on the show's Adverts page, or check the container log.`,
      });
    }
  }

  function setAvailable() {
    state = 'ready';
    consecutiveFailures = 0;
    health?.clear('whisper_unavailable');
    health?.clear('whisper_failing');
  }

  function noteFailure(error) {
    if (error?.code === 'missing') {
      setUnavailable('missing', error.message + '.');
      return;
    }
    consecutiveFailures += 1;
    if (consecutiveFailures >= BREAKER_FAILURES) {
      openUntil = Date.now() + BREAKER_OPEN_MS;
      setUnavailable('failing', `The last ${consecutiveFailures} runs failed (${error?.message ?? error}).`);
    }
  }

  /**
   * Proves the recogniser on a one-second file. Cheap, and the difference between a
   * banner that says why nothing is being heard and a feed that silently waits.
   */
  async function probe() {
    try {
      await access(SMOKE_WAV);
    } catch {
      // No fixture to prove with (an unusual install); trust the first real run.
      state = 'ready';
      return state;
    }
    let lastError = null;
    let gpuProblem = null;
    for (const candidate of candidates) {
      const isCuda = candidate === cudaBinary && !config.whisperBinary;
      const prefix = join(config.tempDir, `tx-probe-${newId()}`);
      try {
        const { json, log } = await runner({
          binary: candidate,
          model: modelPath,
          wavPath: SMOKE_WAV,
          outputPrefix: prefix,
          threads,
          timeoutMs: 120_000,
          logger,
          prints: true,
        });
        if (!Array.isArray(json?.transcription)) throw new WhisperError('bad_output', 'the probe produced no transcript');
        const used = deviceFromLog(log);
        if (isCuda && used.accelerator !== 'gpu') {
          // It ran, but on the CPU: no GPU is visible to the container. The CPU build
          // beside it is the better CPU binary, so that is what is used — and it is said.
          gpuProblem = 'The GPU build started but found no GPU, so it would have run on the processor.';
          continue;
        }
        binaryPath = candidate;
        accelerator = used.accelerator ?? (isCuda ? 'gpu' : 'cpu');
        device = used.device;
        setAvailable();
        if (gpuProblem) {
          health?.set('whisper_gpu_unused', {
            level: 'warn',
            message: 'SelfPod is listening with the processor, not the GPU.',
            detail: `${gpuProblem} Check that the app has the GPU allocated (TrueNAS: edit the app, GPU configuration) and that the NVIDIA driver is installed for apps. Everything still works, more slowly.`,
          });
        } else {
          health?.clear('whisper_gpu_unused');
        }
        logger?.info({ binary: binaryPath, model: modelPath, accelerator, device }, 'the speech recogniser is ready');
        return state;
      } catch (error) {
        lastError = error;
        if (isCuda) {
          gpuProblem = `The GPU build could not run (${error?.message ?? error}).`;
          logger?.warn({ err: error, binary: candidate }, 'the GPU build of the speech recogniser could not run; trying the CPU build');
        }
      }
    }
    const error = lastError ?? new WhisperError('crashed', gpuProblem ?? 'no recogniser could run');
    if (error?.code === 'missing') setUnavailable('missing', `${error.message}.`);
    else setUnavailable('failing', `The check at start-up failed: ${error?.message ?? error}.`);
    logger?.warn({ err: error, binary: binaryPath }, 'the speech recogniser is not available');
    return state;
  }

  function available() {
    if (state === 'failing' && Date.now() >= openUntil) {
      // The breaker has had its rest; the next run decides.
      state = 'ready';
      health?.clear('whisper_failing');
    }
    return state === 'ready';
  }

  function scopeFor(show) {
    const mode = TRANSCRIBE_MODES.includes(show.ad_transcribe) ? show.ad_transcribe : 'edges';
    return {
      mode,
      headMs: (show.ad_transcribe_head_seconds ?? 300) * 1000,
      tailMs: (show.ad_transcribe_tail_seconds ?? 240) * 1000,
    };
  }

  /** The windows to listen to, given the show's settings and the episode's length. */
  function windowsFor(scope, durationMs) {
    if (scope.mode === 'off') return [];
    if (scope.mode === 'whole' || scope.headMs + scope.tailMs >= durationMs) {
      return [{ kind: 'whole', fromMs: 0, toMs: durationMs }];
    }
    const windows = [];
    if (scope.headMs > 0) windows.push({ kind: 'head', fromMs: 0, toMs: scope.headMs });
    if (scope.tailMs > 0) windows.push({ kind: 'tail', fromMs: durationMs - scope.tailMs, toMs: durationMs });
    return windows;
  }

  /**
   * Whether an episode is owed a transcript under the show's current settings.
   *
   * Reads no audio: the file's identity comes from the fingerprint row, which the stage
   * before this one keeps current, so this is cheap enough to ask on every tick.
   */
  function needsTranscript(episode, show) {
    if (!isMp3(episode)) return false;
    const scope = scopeFor(show);
    if (scope.mode === 'off') return false;
    const row = selectRow.get(episode.id);
    if (!row) return true;
    const fingerprint = selectFingerprint.get(episode.id);
    if (fingerprint && fingerprint.sha256 !== row.sha256) return true;
    if (row.algorithm_version !== TRANSCRIPT_VERSION) return true;
    /*
     * A different recogniser hears different words, which is the entire reason for
     * changing one: `small` catches a jingle over music that `base` drops. Without
     * this, pointing WHISPER_MODEL at a better model changed nothing about any episode
     * already read — the owner would have made the change, waited, and watched the
     * same words stay wrong, with nothing anywhere saying why.
     */
    if (row.status === 'ok' && row.model !== modelName) return true;
    const scopeName = scope.mode === 'whole' ? 'whole' : 'edges';
    if (row.status === 'ok' && (row.scope !== scopeName || row.head_ms !== scope.headMs || row.tail_ms !== scope.tailMs)) {
      // A whole-episode transcript already covers any pair of edges.
      if (!(row.scope === 'whole' && scopeName === 'edges')) return true;
    }
    if (row.status === 'failed') {
      if (row.attempts >= MAX_ATTEMPTS) return false;
      return Date.now() - Date.parse(row.attempted_at) >= RETRY_AFTER_MS;
    }
    return false;
  }

  /**
   * Decodes one window of the episode to a WAV file, in the worker.
   *
   * Only the window's bytes are read — from a few frames before it, so the decoder's
   * bit reservoir is primed by the time the window starts; their output is dropped.
   */
  async function decodeWindow(source, window, wavPath) {
    const { frames } = source;
    const first = framesForMs(frames, window.fromMs);
    const last = window.toMs >= source.durationMs ? frames.length : framesForMs(frames, window.toMs);
    const primerStart = Math.max(0, first - PRIMER_FRAMES);
    const skipMs = frameIndexToMs(frames, first) - frameIndexToMs(frames, primerStart);
    const skipSamples = Math.round((skipMs * SAMPLE_RATE) / 1000);
    const slice = frames.slice(primerStart, last);
    if (!slice.length) return { samples: 0, errors: 0, envelope: new Uint8Array(0), hopMs: 10 };
    const start = slice[0].offset;
    const end = slice[slice.length - 1].offset + slice[slice.length - 1].length;
    return audioWorker.decodeWindow({
      path: source.path,
      maxBytes: MAX_PIPELINE_FILE_BYTES,
      start,
      end,
      frames: slice.map((frame) => ({ offset: frame.offset - start, length: frame.length })),
      skipSamples,
      wavPath,
      targetRate: SAMPLE_RATE,
    });
  }

  async function transcribeWindow(source, window, index, context) {
    const id = newId();
    const wavPath = join(config.tempDir, `tx-${id}.wav`);
    const prefix = join(config.tempDir, `tx-${id}`);
    try {
      const decoded = await decodeWindow(source, window, wavPath);
      const { json, elapsedMs } = await runner({
        binary: binaryPath,
        model: modelPath,
        wavPath,
        outputPrefix: prefix,
        threads,
        nice: config.whisperNice ?? 15,
        timeoutMs: timeoutFor(window.toMs - window.fromMs),
        logger,
        // Not read by whisper-cli; it lets a stand-in recogniser in a test know what it
        // is being asked to hear.
        context: { ...context, window },
      });
      const { language, sentences } = wordsFromWhisper(json, { offsetMs: window.fromMs, window: index });
      return {
        kind: window.kind,
        fromMs: window.fromMs,
        toMs: window.toMs,
        language,
        sentences: filterHallucinations(sentences),
        envelope: encodeEnvelope(decoded.envelope),
        hopMs: decoded.hopMs,
        elapsedMs,
      };
    } finally {
      await rm(wavPath, { force: true }).catch(() => {});
    }
  }

  /**
   * What a refusal to read a file becomes here: a quiet skip for a file that is
   * merely gone, otherwise a banner naming the file and a result the pass records.
   * The fingerprinter has usually said the same thing already; the banner key is
   * shared so the owner sees one line about the file, not two.
   */
  function refuseToRead(episode, gate) {
    if (gate.quiet) {
      logger?.debug({ episodeId: episode.id, reason: gate.refused }, 'could not read episode for transcription');
      return { skipped: 'unreadable' };
    }
    const key = `ad_read_${episode.id}`;
    const detail = `${gate.message} Nothing will be cut from it; it is published as it is.`;
    // The banner stays for as long as the file does; the activity log gets one line,
    // when the refusal is new or says something different, not one every pass.
    const fresh = health?.get(key)?.detail !== detail;
    if (fresh) logger?.warn({ episodeId: episode.id, filename: episode.filename, reason: gate.refused }, gate.message);
    health?.set(key, { level: 'warn', message: `SelfPod will not read “${episode.title}” to look for adverts.`, detail });
    return { skipped: 'refused', reason: gate.refused, message: gate.message, fresh };
  }

  /**
   * Hears one episode. Returns what happened rather than throwing, because the caller
   * is a loop over a show and one bad file must not stop the rest.
   */
  async function transcribeEpisode(episode, show, { force = false } = {}) {
    if (!isMp3(episode)) return { skipped: 'unsupported_format' };
    const scope = scopeFor(show);
    if (scope.mode === 'off') return { skipped: 'transcription_off' };
    if (!force && !needsTranscript(episode, show)) return { skipped: 'unchanged' };
    if (!available()) return { skipped: 'unavailable' };

    const gate = await gateEpisodeFile(shows.dirFor(show), episode.filename, { maxBytes: MAX_PIPELINE_FILE_BYTES });
    if (gate.refused) return refuseToRead(episode, gate);
    let profiled;
    try {
      profiled = await audioWorker.profileFile({ path: gate.path, maxBytes: MAX_PIPELINE_FILE_BYTES });
    } catch (error) {
      if (error?.code === 'refused') return refuseToRead(episode, { refused: error.refused, message: error.message, quiet: false });
      logger?.debug({ err: error, episodeId: episode.id }, 'could not read episode for transcription');
      return { skipped: 'unreadable' };
    }
    if (profiled.noFrames) return { skipped: 'no_frames' };
    if (profiled.truncated) return { skipped: 'too_long' };
    const sha256 = profiled.sha256;
    const frames = framesFromTable(profiled.table);
    const profile = { durationMs: profiled.durationMs, sampleRate: profiled.sampleRate, frames };
    const source = { path: gate.path, frames, durationMs: profiled.durationMs };

    const windows = windowsFor(scope, profile.durationMs);
    const previous = selectRow.get(episode.id);
    const attempts = previous?.status === 'failed' && previous.sha256 === sha256 ? previous.attempts + 1 : 1;
    // Recorded as the *setting* it was made under, not the windows it came out as: a
    // short episode listened to whole under 'edges' is still an 'edges' transcript.
    const scopeName = scope.mode === 'whole' ? 'whole' : 'edges';
    const base = {
      episode_id: episode.id,
      algorithm_version: TRANSCRIPT_VERSION,
      model: modelName,
      scope: scopeName,
      head_ms: scope.headMs,
      tail_ms: scope.tailMs,
      attempts,
      attempted_at: nowIso(),
      sha256,
      bytes: profiled.bytes,
      created_at: nowIso(),
    };

    active = { showId: show.id, episodeId: episode.id, title: episode.title };
    const started = Date.now();
    try {
      const heard = [];
      for (const [index, window] of windows.entries()) {
        heard.push(await transcribeWindow(source, window, index, { episodeId: episode.id, filename: episode.filename }));
      }
      const audioMs = windows.reduce((sum, window) => sum + (window.toMs - window.fromMs), 0);
      const cpuMs = Date.now() - started;
      lastRate = audioMs / Math.max(1, cpuMs);

      const transcript = {
        version: TRANSCRIPT_VERSION,
        model: base.model,
        language: heard.find((window) => window.language)?.language ?? null,
        durationMs: profile.durationMs,
        sampleRate: profile.sampleRate,
        samplesPerFrame: profile.frames[0]?.samplesPerFrame ?? 1152,
        windows: heard.map(({ elapsedMs, ...window }) => window),
      };
      const target = transcriptPath(show.id, episode.id);
      await mkdir(dirname(target), { recursive: true });
      const staging = `${target}.${newId()}.tmp`;
      await writeFile(staging, JSON.stringify(transcript));
      await rename(staging, target);

      const wordCount = heard.reduce(
        (sum, window) => sum + window.sentences.reduce((n, sentence) => n + sentence.words.length, 0),
        0,
      );
      upsertRow.run({ ...base, language: transcript.language, status: 'ok', failure: null, word_count: wordCount, cpu_ms: cpuMs });
      consecutiveFailures = 0;
      events?.emit(EVENTS.TRANSCRIPT_READY, { showId: show.id, episodeId: episode.id });
      logger?.info(
        { showId: show.id, episodeId: episode.id, windows: windows.map((w) => w.kind), words: wordCount, audioMs, ms: cpuMs },
        'heard an episode',
      );
      return { transcribed: true, words: wordCount, language: transcript.language, cpuMs, audioMs };
    } catch (error) {
      const failure = error instanceof WhisperError ? error.code : 'crashed';
      upsertRow.run({ ...base, language: null, status: 'failed', failure, word_count: null, cpu_ms: Date.now() - started });
      noteFailure(error);
      logger?.warn({ err: error, showId: show.id, episodeId: episode.id, attempts }, 'could not hear an episode');
      return { failed: failure, attempts };
    } finally {
      active = null;
    }
  }

  const api = {
    probe,
    available,
    needsTranscript,
    transcribeEpisode,
    scopeFor,
    windowsFor,

    /** Where SelfPod is listening right now, for the status endpoint and the page. */
    status() {
      return { state, active, rate: lastRate, accelerator, device };
    },

    /**
     * Hears every held episode of a show, newest first, then a couple of the rest.
     *
     * Held episodes are the ones somebody is waiting on; the backfill of what was
     * published long ago is bounded per run so a fresh episode never queues behind
     * fifty old ones on a box that is also serving audio.
     */
    async transcribeShow(showId) {
      const show = shows.getOrThrow(showId);
      const counts = { transcribed: 0, failed: 0, skipped: 0, pending: 0, backfilled: 0, refused: [] };
      if (scopeFor(show).mode === 'off') return counts;
      if (state === 'unknown') await probe();
      const owed = episodes.listByShow(show.id).filter((episode) => needsTranscript(episode, show));
      counts.pending = owed.length;
      if (!available()) return counts;

      const held = owed.filter((episode) => episode.publish_hold);
      const rest = owed.filter((episode) => !episode.publish_hold).slice(0, config.whisperBackfillPerRun ?? MAX_BACKFILL_PER_RUN);
      for (const episode of [...held, ...rest]) {
        if (!available()) break;
        const result = await transcribeEpisode(episode, show);
        if (result.transcribed) {
          counts.transcribed += 1;
          counts.pending -= 1;
          if (!episode.publish_hold) counts.backfilled += 1;
        } else if (result.failed) counts.failed += 1;
        else {
          counts.skipped += 1;
          // Said out loud by the pass, with the fingerprinter's refusals of the same files.
          if (result.skipped === 'refused' && result.fresh) {
            counts.refused.push({ episodeId: episode.id, filename: episode.filename, message: result.message });
          }
        }
        events?.emit(EVENTS.TRANSCRIBE_PROGRESS, {
          showId: show.id,
          slug: show.slug,
          done: counts.transcribed,
          total: owed.length,
          title: episode.title,
          rate: lastRate,
        });
      }
      return counts;
    },

    /** The transcript row for an episode, for pages that say what happened to it. */
    rowFor(episodeId) {
      return selectRow.get(episodeId) ?? null;
    },

    /** The stored transcript for an episode, or null when there is none to read. */
    async loadTranscript(episode) {
      const row = selectRow.get(episode.id);
      if (!row || row.status !== 'ok' || row.algorithm_version !== TRANSCRIPT_VERSION) return null;
      try {
        const transcript = JSON.parse(await readFile(transcriptPath(episode.show_id, episode.id), 'utf8'));
        for (const window of transcript.windows) window.envelopeBytes = decodeEnvelope(window.envelope);
        return { ...transcript, episodeId: episode.id, row };
      } catch {
        return null;
      }
    },

    /** How far a show's listening has got, for the page and the activity log. */
    progress(showId) {
      const show = shows.get(showId);
      const counts = { done: 0, failed: 0, pending: 0, unsupported: 0, total: 0, mode: 'off' };
      if (!show) return counts;
      const scope = scopeFor(show);
      counts.mode = scope.mode;
      for (const episode of episodes.listByShow(showId)) {
        counts.total += 1;
        if (!isMp3(episode)) {
          counts.unsupported += 1;
          continue;
        }
        const row = selectRow.get(episode.id);
        if (row?.status === 'ok' && !needsTranscript(episode, show)) counts.done += 1;
        else if (row?.status === 'failed' && row.attempts >= MAX_ATTEMPTS) counts.failed += 1;
        else if (scope.mode !== 'off') counts.pending += 1;
      }
      return counts;
    },

    /**
     * Forgets a show's transcripts, so changed listening settings take effect.
     *
     * The files go with the rows. Left behind, they were words from the old settings
     * sitting under /data/.tx for as long as each episode happened not to be read again.
     */
    async forgetShow(showId) {
      db.prepare(
        'DELETE FROM episode_transcripts WHERE episode_id IN (SELECT id FROM episodes WHERE show_id = ?)',
      ).run(showId);
      await rm(join(config.transcriptDir, showId), { recursive: true, force: true }).catch((error) => {
        logger?.warn({ err: error, showId }, 'could not remove the old transcripts of a show');
      });
    },

    /** Stops the audio worker, if this instance owns one. Called on shutdown, and by tests. */
    async close() {
      if (!audio) await audioWorker.close();
    },

    /** The one place the human-readable form of the model name lives. */
    engineLabel() {
      return `whisper.cpp (${modelPath.slice(modelPath.lastIndexOf('/') + 1).replace(/^ggml-|\.bin$/g, '')})`;
    },
  };

  return api;
}
