import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Which of the shipped whisper binaries this machine can run.
 *
 * The amd64 image carries two builds: one that uses AVX2, which is several times
 * faster, and one that stops at SSE4.2, because the Celerons in most small NAS boxes
 * have no AVX at all and a binary that assumes it dies with an illegal instruction.
 * The arm64 image carries one. Reading the choice off /proc/cpuinfo at boot costs
 * nothing and is the difference between the feature working and a health banner.
 */
export function pickWhisperBinary(directory, { platform = process.platform, arch = process.arch, cpuinfo = null } = {}) {
  if (arch !== 'x64') return join(directory, 'whisper-cli');
  let flags = cpuinfo;
  if (flags === null && platform === 'linux') {
    try {
      flags = readFileSync('/proc/cpuinfo', 'utf8');
    } catch {
      flags = '';
    }
  }
  const line = /^flags\s*:\s*(.*)$/m.exec(flags ?? '')?.[1] ?? '';
  const has = (flag) => line.split(/\s+/).includes(flag);
  if (has('avx2') && has('fma') && has('f16c')) return join(directory, 'whisper-cli-v3');
  return join(directory, 'whisper-cli-v2');
}
