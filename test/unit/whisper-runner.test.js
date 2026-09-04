import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { runWhisper, timeoutFor } from '../../src/lib/whisper-runner.js';
import { wordsFromWhisper } from '../../src/lib/transcript.js';
import { pickWhisperBinary } from '../../src/lib/cpu-features.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'whisper');

/**
 * Stand-ins for whisper-cli. Shell scripts rather than Node, because the point is the
 * runner's handling of a real child process: its exit code, its signal, its files.
 */
let dir;
async function stub(name, body) {
  const path = join(dir, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

describe('running whisper-cli', () => {
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'selfpod-whisper-'));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('passes the file and reads back the transcript it was told to write', async () => {
    const fixture = await readFile(join(FIXTURES, 'volkswagen-opening.json'), 'utf8');
    await writeFile(join(dir, 'canned.json'), fixture);
    // Finds the --output-file argument and writes the canned transcript there.
    const binary = await stub(
      'ok.sh',
      'while [ $# -gt 0 ]; do if [ "$1" = "--output-file" ]; then out="$2"; fi; shift; done; cp "$(dirname "$0")/canned.json" "$out.json"',
    );
    const { json, elapsedMs } = await runWhisper({ binary, model: 'm.bin', wavPath: 'in.wav', outputPrefix: join(dir, 'out') });
    assert.ok(elapsedMs >= 0);
    const { language, sentences } = wordsFromWhisper(json);
    assert.equal(language, 'fr');
    assert.equal(sentences[0].words[0].w, 'Dans');
    // The JSON file is cleaned up behind it.
    await assert.rejects(readFile(join(dir, 'out.json')));
  });

  it('reports a missing binary as such', async () => {
    await assert.rejects(
      runWhisper({ binary: join(dir, 'nope'), model: 'm', wavPath: 'w', outputPrefix: join(dir, 'x') }),
      (error) => error.name === 'WhisperError' && error.code === 'missing',
    );
  });

  it('kills a run that goes on too long and says so', async () => {
    const binary = await stub('slow.sh', 'sleep 30');
    const started = Date.now();
    await assert.rejects(
      runWhisper({ binary, model: 'm', wavPath: 'w', outputPrefix: join(dir, 'x'), timeoutMs: 300 }),
      (error) => error.code === 'timeout',
    );
    assert.ok(Date.now() - started < 5000, 'did not wait for the child to finish on its own');
  });

  it('reports a crash with the tail of what it said', async () => {
    const binary = await stub('crash.sh', 'echo "ggml: illegal instruction" 1>&2; exit 132');
    await assert.rejects(
      runWhisper({ binary, model: 'm', wavPath: 'w', outputPrefix: join(dir, 'x') }),
      (error) => error.code === 'crashed' && /illegal instruction/.test(error.message),
    );
  });

  it('refuses output it cannot read', async () => {
    const binary = await stub('junk.sh', 'exit 0');
    await assert.rejects(
      runWhisper({ binary, model: 'm', wavPath: 'w', outputPrefix: join(dir, 'x') }),
      (error) => error.code === 'bad_output',
    );
  });

  it('budgets a minute plus four times the audio, capped', () => {
    assert.equal(timeoutFor(60_000), 300_000);
    assert.equal(timeoutFor(3 * 3_600_000), 45 * 60_000);
  });
});

describe('choosing the binary for the CPU', () => {
  it('takes the AVX2 build only when the flags are all there', () => {
    const avx = 'flags\t\t: fpu vme sse4_2 avx avx2 fma f16c\n';
    const celeron = 'flags\t\t: fpu vme sse4_1 sse4_2 movbe\n';
    assert.equal(pickWhisperBinary('/app/whisper', { arch: 'x64', cpuinfo: avx }), '/app/whisper/whisper-cli-v3');
    assert.equal(pickWhisperBinary('/app/whisper', { arch: 'x64', cpuinfo: celeron }), '/app/whisper/whisper-cli-v2');
    assert.equal(pickWhisperBinary('/app/whisper', { arch: 'x64', cpuinfo: '' }), '/app/whisper/whisper-cli-v2');
    assert.equal(pickWhisperBinary('/app/whisper', { arch: 'arm64' }), '/app/whisper/whisper-cli');
  });
});
