#!/usr/bin/env node
/**
 * Proves every whisper binary in the image on a one-second file, at build time.
 *
 * Run in the *runtime* stage, so what is proved is the binary against the libraries
 * the container will actually have — not the build stage's. A binary that cannot run
 * here fails the build; the alternative is finding out on the NAS, from a health
 * banner, after the update has been applied.
 *
 * The check is loose about the words: the small multilingual model hears "Self pod"
 * as "self-code" or "self pod", and the point is that it heard *something* and wrote
 * it in the shape SelfPod reads, not that it spelled the name.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.WHISPER_DIR ?? '/app/whisper';
const wav = process.env.WHISPER_SMOKE_WAV ?? '/app/docker/fixtures/whisper-smoke.wav';

const models = readdirSync(dir).filter((name) => name.startsWith('ggml-') && name.endsWith('.bin'));
if (!models.length) {
  console.error(`no models in ${dir}`);
  process.exit(1);
}
const binaries = readdirSync(dir).filter((name) => name.startsWith('whisper-cli'));
if (!binaries.length) {
  console.error(`no whisper-cli binaries in ${dir}`);
  process.exit(1);
}

let failed = 0;
for (const [name, modelName] of binaries.flatMap((binary) => models.map((model) => [binary, model]))) {
  const binary = join(dir, name);
  const model = join(dir, modelName);
  const prefix = `/tmp/whisper-smoke-${name}-${modelName}`;
  try {
    execFileSync(binary, ['-m', model, '-f', wav, '-l', 'auto', '-t', '2', '--output-json-full', '--output-file', prefix, '--no-prints'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 120_000,
    });
    const json = JSON.parse(readFileSync(`${prefix}.json`, 'utf8'));
    rmSync(`${prefix}.json`, { force: true });
    const text = (json.transcription ?? []).map((segment) => segment.text).join(' ').trim();
    if (!Array.isArray(json.transcription) || !text) throw new Error('heard nothing');
    if (!/self/i.test(text)) throw new Error(`heard "${text}" for "Self pod"`);
    console.log(`${name} + ${modelName}: ok — "${text}"`);
  } catch (error) {
    failed += 1;
    // An illegal instruction on the build host is expected for a build the host cannot
    // run (there is none today: CI runners have AVX2); anything else is a broken build.
    console.error(`${name} + ${modelName}: FAILED — ${error.message}`);
  }
}
process.exit(failed ? 1 : 0);
