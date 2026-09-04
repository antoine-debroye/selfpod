import { execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { setPriority } from 'node:os';

/**
 * Running whisper.cpp on a WAV file and reading back what it heard (spec §19.6).
 *
 * The first, and so far only, subprocess in SelfPod, so the reasons it is one are
 * written here. The case against ffmpeg was a video-codec stack fed files chosen by
 * strangers; this binary is two megabytes of MIT-licensed code that reads a WAV
 * SelfPod's own decoder wrote a moment ago. And a child process is the *safer* shape
 * for it: an illegal instruction or a bad allocation in a maths library kills the
 * child and not the process serving the feed; the several hundred megabytes a model
 * needs go back to the operating system when the child exits, which they would not do
 * from inside a musl-linked Node process; and a run that has gone on too long is
 * ended with one signal rather than an in-process cancellation nobody can promise.
 *
 * No shell. The arguments are an array, the output is read from a file the binary was
 * told to write, and the process runs at low priority because the feed and the audio
 * being served matter more than a transcript that is not due for another tick.
 */

export class WhisperError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, { cause });
    this.name = 'WhisperError';
    this.code = code; // 'missing' | 'timeout' | 'crashed' | 'bad_output'
  }
}

/** Longest any single run may take, whatever the window. */
export const MAX_RUN_MS = 45 * 60 * 1000;

/** A generous budget: a minute, plus four times the audio's length. */
export function timeoutFor(audioMs) {
  return Math.min(MAX_RUN_MS, 60_000 + 4 * audioMs);
}

/**
 * @param {{binary: string, model: string, wavPath: string, outputPrefix: string, threads?: number, timeoutMs?: number, language?: string, logger?: object}} options
 * @returns {Promise<{json: object, elapsedMs: number}>} the parsed `--output-json-full` file
 */
export async function runWhisper({
  binary,
  model,
  wavPath,
  outputPrefix,
  threads = 2,
  timeoutMs = MAX_RUN_MS,
  language = 'auto',
  logger = null,
}) {
  const args = [
    '-m', model,
    '-f', wavPath,
    '-l', language,
    '-t', String(threads),
    '--output-json-full',
    '--output-file', outputPrefix,
    '--no-prints',
    '--suppress-nst',
  ];
  const started = Date.now();

  await new Promise((resolve, reject) => {
    let child;
    try {
      child = execFile(
        binary,
        args,
        { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1 << 20, windowsHide: true },
        (error, stdout, stderr) => {
          if (!error) return resolve();
          if (error.code === 'ENOENT' || error.code === 'EACCES') {
            return reject(new WhisperError('missing', `whisper-cli is not runnable at ${binary}`, { cause: error }));
          }
          if (error.killed || error.signal === 'SIGKILL') {
            return reject(new WhisperError('timeout', `whisper-cli gave up after ${Math.round(timeoutMs / 1000)}s`, { cause: error }));
          }
          const tail = String(stderr ?? '').trim().split('\n').slice(-3).join(' | ');
          reject(
            new WhisperError(
              'crashed',
              `whisper-cli exited with ${error.signal ?? error.code}${tail ? `: ${tail}` : ''}`,
              { cause: error },
            ),
          );
        },
      );
    } catch (error) {
      return reject(new WhisperError('missing', `whisper-cli could not be started at ${binary}`, { cause: error }));
    }
    if (child?.pid) {
      try {
        setPriority(child.pid, 15);
      } catch (error) {
        logger?.debug({ err: error }, 'could not lower the priority of whisper-cli');
      }
    }
  });

  const elapsedMs = Date.now() - started;
  const jsonPath = `${outputPrefix}.json`;
  let json;
  try {
    json = JSON.parse(await readFile(jsonPath, 'utf8'));
  } catch (error) {
    throw new WhisperError('bad_output', 'whisper-cli finished but wrote no readable transcript', { cause: error });
  } finally {
    await rm(jsonPath, { force: true }).catch(() => {});
  }
  if (!Array.isArray(json?.transcription)) {
    throw new WhisperError('bad_output', 'whisper-cli wrote a transcript in a shape SelfPod does not know');
  }
  return { json, elapsedMs };
}
