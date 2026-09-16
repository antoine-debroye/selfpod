import { Worker } from 'node:worker_threads';

import { findHeadAnchors } from './audio-anchor.js';
import { findRepeatedAudio } from './repeated-audio.js';

const WORKER_URL = new URL('../workers/audio-search.js', import.meta.url);

/**
 * Runs the corpus searches in a worker thread, one long-lived worker per instance.
 *
 * Long-lived rather than one per call because a pass asks twice (the jingle and the
 * repeated audio) and starting a worker costs tens of milliseconds and a module load.
 * `unref`'d so it never keeps the process alive, and restarted on the next call if it
 * died. If a worker cannot be started at all the search runs inline, as it did before —
 * slower to live with, never a feature that silently stops.
 */
export function createAudioSearch({ logger = null, inline = false } = {}) {
  let worker = null;
  let nextId = 1;
  const pending = new Map();

  function failAll(error) {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
    worker = null;
  }

  function ensureWorker() {
    if (worker) return worker;
    // No inherited flags: --input-type or a test runner's own flags are refused in a worker.
    worker = new Worker(WORKER_URL, { execArgv: [] });
    worker.unref();
    worker.on('message', ({ id, result, error }) => {
      const waiting = pending.get(id);
      if (!waiting) return;
      pending.delete(id);
      if (error) waiting.reject(Object.assign(new Error(error.message), { stack: error.stack }));
      else waiting.resolve(result);
    });
    worker.on('error', (error) => {
      logger?.warn({ err: error }, 'the audio search worker failed; it will be started again on the next pass');
      failAll(error);
    });
    worker.on('exit', (code) => {
      if (pending.size) failAll(new Error(`the audio search worker exited with code ${code}`));
      worker = null;
    });
    return worker;
  }

  function run(task, payload, fallback) {
    if (inline) return Promise.resolve(fallback());
    let target;
    try {
      target = ensureWorker();
    } catch (error) {
      logger?.warn({ err: error }, 'could not start the audio search worker; searching on the main thread');
      return Promise.resolve(fallback());
    }
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      target.postMessage({ id, task, payload });
    });
  }

  return {
    repeatedAudio(episodes, options) {
      return run('repeatedAudio', { episodes, options }, () => findRepeatedAudio(episodes, options));
    },
    headAnchors(episodes, options) {
      return run('headAnchors', { episodes, options }, () => findHeadAnchors(episodes, options));
    },
    async close() {
      const current = worker;
      worker = null;
      if (current) await current.terminate();
    },
  };
}
