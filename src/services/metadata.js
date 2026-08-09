import { parseFile } from 'music-metadata';

/**
 * Audio metadata extraction.
 *
 * Duration is best-effort by design: spec §8.3 requires `<itunes:duration>` to be
 * *omitted* when unknown rather than emitted as zero, so a null here is a
 * legitimate outcome and not an error. Errors are returned rather than thrown so
 * one unreadable file becomes a visible line in the activity log instead of
 * aborting the whole scan.
 */
export function createMetadata({ logger } = {}) {
  return {
    async read(filePath) {
      const started = Date.now();
      const result = {
        durationSeconds: null,
        bitrateKbps: null,
        title: null,
        description: null,
        season: null,
        episodeNumber: null,
        error: null,
      };

      try {
        // The fast path reads only headers. `duration: true` is the fallback for
        // formats where the header has no reliable length (VBR MP3 without a
        // Xing frame, some WAV/FLAC), and it costs a full-file read — so it is
        // only used when the cheap attempt came back empty.
        let parsed = await parseFile(filePath, { duration: false, skipCovers: true });
        if (!Number.isFinite(parsed?.format?.duration)) {
          parsed = await parseFile(filePath, { duration: true, skipCovers: true });
        }

        const { format = {}, common = {} } = parsed ?? {};

        if (Number.isFinite(format.duration) && format.duration > 0) {
          result.durationSeconds = Math.round(format.duration);
        }
        if (Number.isFinite(format.bitrate) && format.bitrate > 0) {
          result.bitrateKbps = Math.round(format.bitrate / 1000);
        }
        if (typeof common.title === 'string' && common.title.trim()) {
          result.title = common.title.trim();
        }
        const comment = Array.isArray(common.comment)
          ? common.comment
              .map((c) => (typeof c === 'string' ? c : c?.text))
              .find((c) => typeof c === 'string' && c.trim())
          : common.comment;
        if (typeof comment === 'string' && comment.trim()) {
          result.description = comment.trim().slice(0, 4000);
        }
        if (Number.isInteger(common.disk?.no)) result.season = common.disk.no;
        if (Number.isInteger(common.track?.no)) result.episodeNumber = common.track.no;
      } catch (err) {
        result.error = err;
        logger?.debug({ err, filePath }, 'audio metadata extraction failed');
      }

      logger?.debug(
        { filePath, ms: Date.now() - started, duration: result.durationSeconds },
        'read audio metadata',
      );
      return result;
    },
  };
}
