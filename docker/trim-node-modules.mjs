#!/usr/bin/env node
/**
 * Drops what node_modules carries that the image never reads, at build time.
 *
 * better-sqlite3 ships a prebuilt binary for every platform it supports — eight of
 * them, 16 MB — and loads exactly one, chosen by its own `getPrebuildPath()`. The
 * image is built for one platform, so the other seven are dead weight; so is `deps`,
 * the SQLite source it would only compile if no prebuilt matched. Together they are
 * about 24 MB of an image that is mostly whisper models.
 *
 * Asked of the package rather than guessed from `process.platform`, so a musl build
 * keeps the musl binary. Run in the build stage, *before* the native-module check,
 * so that check proves the module still loads with only what is kept. A layout this
 * script does not recognise fails the build with a sentence saying so, rather than
 * trimming blind or quietly doing nothing.
 */
import { createRequire } from 'node:module';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? 'node_modules');
const pkg = join(root, 'better-sqlite3');
const require = createRequire(import.meta.url);

function sizeOf(path) {
  const stats = statSync(path);
  if (!stats.isDirectory()) return stats.size;
  return readdirSync(path).reduce((total, name) => total + sizeOf(join(path, name)), 0);
}
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

let removed = 0;

const deps = join(pkg, 'deps');
if (existsSync(deps)) {
  removed += sizeOf(deps);
  rmSync(deps, { recursive: true, force: true });
}

// The absolute path sidesteps the package's `exports` map, which does not list lib/.
let getPrebuildPath;
try {
  ({ getPrebuildPath } = require(join(pkg, 'lib', 'binding.js')));
} catch (err) {
  console.error(`better-sqlite3's loader is not where this script expects it (${err.message}); update docker/trim-node-modules.mjs for this version before trimming.`);
  process.exit(1);
}
const keep = getPrebuildPath?.();
if (!keep) {
  console.error('better-sqlite3 reports no prebuilt binary for this platform, so there is nothing safe to trim; it will try to compile instead, which the image does not support.');
  process.exit(1);
}
const prebuilds = dirname(keep);
for (const name of readdirSync(prebuilds)) {
  const file = join(prebuilds, name);
  if (file === keep) continue;
  removed += sizeOf(file);
  rmSync(file, { force: true });
}

console.log(`trimmed node_modules: kept ${keep.slice(root.length + 1)}, removed ${mb(removed)}`);
