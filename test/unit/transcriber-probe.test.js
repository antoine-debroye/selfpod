import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import Database from 'better-sqlite3';

import { runMigrations } from '../../src/db/migrate.js';
import { WhisperError } from '../../src/lib/whisper-runner.js';
import { createTranscriber } from '../../src/services/transcriber.js';

/**
 * The GPU image ships a CUDA build beside the CPU builds. What has to be true on a NAS
 * nobody can watch: the GPU build is used only when it really used the GPU; anything
 * else falls back to the CPU build and says so, rather than being quietly slow.
 */
let dir;
let health;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'selfpod-probe-'));
  health = new Map();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function transcriberWith(runner, { cuda = true, whisperBinary = null } = {}) {
  const db = new Database(':memory:');
  runMigrations(db);
  return (async () => {
    if (cuda) await writeFile(join(dir, 'whisper-cli-cuda'), '');
    return createTranscriber({
      db,
      config: { tempDir: dir, transcriptDir: dir, whisperDir: dir, whisperBinary, whisperModel: null, whisperThreads: 2 },
      events: null,
      logger: null,
      health: {
        set: (key, value) => health.set(key, value),
        clear: (key) => health.delete(key),
      },
      shows: {},
      episodes: {},
      runner,
    });
  })();
}

const heard = (log) => ({ json: { transcription: [{ text: 'self pod' }] }, elapsedMs: 5, log });

describe('choosing the GPU build at start-up', () => {
  it('uses the GPU build when it ran on the GPU', async () => {
    const tried = [];
    const transcriber = await transcriberWith(async ({ binary, prints }) => {
      tried.push(binary);
      assert.equal(prints, true, 'the check ran with the log silenced, so it cannot see the device');
      return heard('whisper_backend_init_gpu: using CUDA0 backend');
    });
    assert.equal(await transcriber.probe(), 'ready');
    assert.deepEqual(tried, [join(dir, 'whisper-cli-cuda')]);
    assert.deepEqual(
      (({ accelerator, device }) => ({ accelerator, device }))(transcriber.status()),
      { accelerator: 'gpu', device: 'CUDA0' },
    );
    assert.equal(health.has('whisper_gpu_unused'), false);
  });

  it('falls back to the CPU build, and says so, when the GPU build cannot start', async () => {
    const tried = [];
    const transcriber = await transcriberWith(async ({ binary }) => {
      tried.push(binary);
      if (binary.endsWith('whisper-cli-cuda')) {
        throw new WhisperError('crashed', 'whisper-cli exited with 127: libcuda.so.1: cannot open shared object file');
      }
      return heard('whisper_backend_init_gpu: no GPU found');
    });
    assert.equal(await transcriber.probe(), 'ready');
    assert.equal(tried.length, 2);
    assert.ok(!tried[1].endsWith('whisper-cli-cuda'), 'the fallback was the same GPU build');
    assert.equal(transcriber.status().accelerator, 'cpu');
    assert.match(health.get('whisper_gpu_unused')?.message ?? '', /processor, not the GPU/);
    assert.match(health.get('whisper_gpu_unused').detail, /libcuda/);
  });

  it('does not keep a GPU build that quietly ran on the processor', async () => {
    const tried = [];
    const transcriber = await transcriberWith(async ({ binary }) => {
      tried.push(binary);
      return heard('whisper_backend_init_gpu: no GPU found');
    });
    assert.equal(await transcriber.probe(), 'ready');
    assert.equal(tried.length, 2, 'the CPU build was not tried');
    assert.equal(transcriber.status().accelerator, 'cpu');
    assert.match(health.get('whisper_gpu_unused').detail, /found no GPU/);
  });

  it('tries only the binary the operator named', async () => {
    const tried = [];
    const transcriber = await transcriberWith(
      async ({ binary }) => {
        tried.push(binary);
        return heard('whisper_backend_init_gpu: no GPU found');
      },
      { whisperBinary: '/opt/whisper/whisper-cli' },
    );
    assert.equal(await transcriber.probe(), 'ready');
    assert.deepEqual(tried, ['/opt/whisper/whisper-cli']);
    assert.equal(health.has('whisper_gpu_unused'), false, 'an operator’s own CPU binary was reported as a GPU problem');
  });

  it('with no GPU build in the image, behaves as before', async () => {
    const tried = [];
    const transcriber = await transcriberWith(
      async ({ binary }) => {
        tried.push(binary);
        return heard('');
      },
      { cuda: false },
    );
    assert.equal(await transcriber.probe(), 'ready');
    assert.equal(tried.length, 1);
    assert.equal(transcriber.status().accelerator, 'cpu');
  });
});
