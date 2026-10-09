import { parentPort } from 'node:worker_threads';

import { findHeadAnchors } from '../lib/audio-anchor.js';
import { decodeWindowToWav, fingerprintFile, profileFile } from '../lib/audio-tasks.js';
import { findRepeatedAudio } from '../lib/repeated-audio.js';

/**
 * The audio work that must not run on the thread serving listeners.
 *
 * Two kinds. The corpus searches compare every episode with every other — pure
 * arithmetic over fingerprints, quadratic in episode count: forty episodes held the
 * main thread for sixteen seconds. And the per-file work: reading, hashing and
 * *decoding* an episode to fingerprint it or to hand its words to the recogniser,
 * which is twelve seconds of blocked loop for an hour of MP3 on a desktop and
 * several times that on a NAS — long enough for the container's health check to
 * time out three times and have the app restarted mid-pass.
 *
 * The searches take arrays in and give plain objects back. The file tasks read
 * their own file (through the same containment and size gate as the main thread)
 * and hand back typed arrays, transferred rather than copied. Nothing here touches
 * the database.
 */
const TASKS = {
  repeatedAudio: ({ episodes, options }) => ({ result: findRepeatedAudio(episodes, options) }),
  headAnchors: ({ episodes, options }) => ({ result: findHeadAnchors(episodes, options) }),
  fingerprintFile,
  profileFile,
  decodeWindow: decodeWindowToWav,
};

parentPort.on('message', async ({ id, task, payload }) => {
  try {
    const run = TASKS[task];
    if (!run) throw new Error(`unknown task ${task}`);
    const { result, transfer = [] } = await run(payload);
    parentPort.postMessage({ id, result }, transfer);
  } catch (error) {
    parentPort.postMessage({
      id,
      error: { message: error.message, stack: error.stack, code: error.code ?? null, refused: error.refused ?? null },
    });
  }
});
