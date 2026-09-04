/**
 * Canned recogniser output, in whisper-cli's own `--output-json-full` shape, so a test
 * can say what an episode "says" and drive the real transcriber, catalogue and cutter
 * with it. The only thing faked is the binary.
 */

/**
 * @param {Array<{from: number, to: number, text: string}>} sentences timings in ms
 * @param {{language?: string}} [options]
 */
export function whisperJson(sentences, { language = 'en' } = {}) {
  return {
    result: { language },
    transcription: sentences.map(({ from, to, text }) => {
      const words = text.trim().split(/\s+/);
      const step = (to - from) / words.length;
      return {
        timestamps: { from: String(from), to: String(to) },
        offsets: { from, to },
        text: ` ${text.trim()}`,
        tokens: [
          { text: '[_BEG_]', offsets: { from, to: from }, p: 1, t_dtw: -1 },
          ...words.map((word, i) => ({
            text: ` ${word}`,
            offsets: { from: Math.round(from + i * step), to: Math.round(from + (i + 1) * step) - 20 },
            p: 0.9,
            t_dtw: -1,
          })),
        ],
      };
    }),
  };
}

/**
 * A stand-in runner keyed by the episode's filename. Anything not in `byFilename`
 * is heard as silence (an empty transcript). `calls` records every run.
 */
export function cannedWhisper(byFilename) {
  const calls = [];
  const runner = async (options) => {
    calls.push(options);
    const filename = options.context?.filename;
    if (!filename) return { json: whisperJson([]), elapsedMs: 1 };
    const canned = byFilename[filename];
    if (canned instanceof Error) throw canned;
    return { json: canned ?? whisperJson([]), elapsedMs: 1 };
  };
  runner.calls = calls;
  return runner;
}
