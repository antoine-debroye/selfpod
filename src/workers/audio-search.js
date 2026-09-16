import { parentPort } from 'node:worker_threads';

import { findHeadAnchors } from '../lib/audio-anchor.js';
import { findRepeatedAudio } from '../lib/repeated-audio.js';

/**
 * The two searches that compare every episode with every other, off the main thread.
 *
 * They are pure arithmetic over fingerprints and quadratic in episode count, and the
 * main thread is the one serving listeners' downloads and answering the container's
 * health check. Run there, forty episodes held both for sixteen seconds, and a longer
 * show held them long enough for the host to restart the app mid-pass — for ever.
 * Nothing here touches the database or the disk: arrays in, plain objects out.
 */
const TASKS = {
  repeatedAudio: ({ episodes, options }) => findRepeatedAudio(episodes, options),
  headAnchors: ({ episodes, options }) => findHeadAnchors(episodes, options),
};

parentPort.on('message', ({ id, task, payload }) => {
  try {
    const run = TASKS[task];
    if (!run) throw new Error(`unknown task ${task}`);
    parentPort.postMessage({ id, result: run(payload) });
  } catch (error) {
    parentPort.postMessage({ id, error: { message: error.message, stack: error.stack } });
  }
});
