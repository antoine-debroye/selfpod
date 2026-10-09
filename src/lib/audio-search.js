import { Worker } from 'node:worker_threads';

import { findHeadAnchors } from './audio-anchor.js';
import { decodeWindowToWav, fingerprintFile, profileFile } from './audio-tasks.js';
import { findRepeatedAudio } from './repeated-audio.js';

const WORKER_URL = new URL('../workers/audio-search.js', import.meta.url);

/**
 * How long a file task may take before the worker is stopped and the episode
 * reported as failed. Generous on purpose: a five-hour episode on a two-core NAS is
 * minutes of decoding, and a timeout that fires on honest work would turn a slow box
 * into one that never fingerprints anything. It exists for the other case — a decoder
 * wedged on a hostile file — so that a pass is reported as failed rather than hung.
 */
export const FILE_TASK_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Runs the audio work in a worker thread, one long-lived worker per instance.
 *
 * Long-lived rather than one per call because a pass asks many times — every
 * episode to fingerprint, every window to decode, then the two corpus searches —
 * and starting a worker costs tens of milliseconds and a module load. `unref`'d so
 * it never keeps the process alive, and restarted on the next call if it died. If a
 * worker cannot be started at all the work runs inline, as it did before — slower to
 * live with, never a feature that silently stops.
 *
 * A worker that crashes, or a file task that outlives its timeout, rejects the
 * calls waiting on it with an error that says so; the caller reports that episode
 * as failed and moves on, and the next call starts a fresh worker.
 */
export function createAudioWorker({ logger = null, inline = false, fileTimeoutMs = FILE_TASK_TIMEOUT_MS } = {}) {
  let worker = null;
  let nextId = 1;
  const pending = new Map();

  function failAll(error) {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
    worker = null;
  }

  function ensureWorker() {
    if (worker) return worker;
    // No inherited flags: --input-type or a test runner's own flags are refused in a worker.
    const started = new Worker(WORKER_URL, { execArgv: [] });
    worker = started;
    started.unref();
    started.on('message', ({ id, result, error }) => {
      const waiting = pending.get(id);
      if (!waiting) return;
      pending.delete(id);
      clearTimeout(waiting.timer);
      if (error) {
        waiting.reject(Object.assign(new Error(error.message), { stack: error.stack, code: error.code, refused: error.refused }));
      } else {
        waiting.resolve(result);
      }
    });
    started.on('error', (error) => {
      logger?.warn({ err: error }, 'the audio worker failed; it will be started again on the next pass');
      if (worker === started) failAll(error);
    });
    started.on('exit', (code) => {
      // Only this worker's own slot: a replacement started after a timeout or a
      // crash must not be forgotten when the old one finally reports its exit.
      if (worker !== started) return;
      if (pending.size) failAll(new Error(`the audio worker exited with code ${code}`));
      worker = null;
    });
    return started;
  }

  function run(task, payload, fallback, { timeoutMs = 0 } = {}) {
    if (inline) return Promise.resolve().then(fallback);
    let target;
    try {
      target = ensureWorker();
    } catch (error) {
      logger?.warn({ err: error }, 'could not start the audio worker; working on the main thread');
      return Promise.resolve().then(fallback);
    }
    return new Promise((resolve, reject) => {
      const id = nextId++;
      let timer = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`the audio work took longer than ${Math.round(timeoutMs / 1000)} seconds and was stopped`));
          // The worker is wedged on this file, so everything else waiting on it is
          // told so too, and the next call gets a fresh one.
          const stuck = worker;
          worker = null;
          failAll(new Error('the audio worker was stopped after a task timed out'));
          stuck?.terminate().catch(() => {});
        }, timeoutMs);
        timer.unref?.();
      }
      pending.set(id, { resolve, reject, timer });
      target.postMessage({ id, task, payload });
    });
  }

  /** Inline fallbacks unwrap the `{ result }` envelope the worker would have sent. */
  const unwrap = async (work) => (await work()).result;

  return {
    repeatedAudio(episodes, options) {
      return run('repeatedAudio', { episodes, options }, () => findRepeatedAudio(episodes, options));
    },
    headAnchors(episodes, options) {
      return run('headAnchors', { episodes, options }, () => findHeadAnchors(episodes, options));
    },
    /** @see fingerprintFile in audio-tasks.js */
    fingerprintFile(payload) {
      return run('fingerprintFile', payload, () => unwrap(() => fingerprintFile(payload)), { timeoutMs: fileTimeoutMs });
    },
    /** @see profileFile in audio-tasks.js */
    profileFile(payload) {
      return run('profileFile', payload, () => unwrap(() => profileFile(payload)), { timeoutMs: fileTimeoutMs });
    },
    /** @see decodeWindowToWav in audio-tasks.js */
    decodeWindow(payload) {
      return run('decodeWindow', payload, () => unwrap(() => decodeWindowToWav(payload)), { timeoutMs: fileTimeoutMs });
    },
    async close() {
      const current = worker;
      worker = null;
      if (current) await current.terminate();
    },
  };
}

/** The name this had when it only searched. */
export const createAudioSearch = createAudioWorker;
