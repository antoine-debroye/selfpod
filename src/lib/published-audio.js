/**
 * Which bytes an episode publishes: the original, or the trimmed copy (spec §19.7).
 *
 * One function rather than a check in each place, because the feed and the media route
 * have to agree. The feed states a length and a duration; the route sends a file and
 * answers byte-range requests against it. If those two ever disagreed about which file
 * the episode is, the feed would advertise one size and the route would serve another
 * — and the client that notices is the one seeking through an episode.
 *
 * The condition is the filename alone, deliberately, and not the trim status. A copy
 * whose cut list has since changed is stale, not wrong — it is a real cut of this
 * episode and it is what subscribers already have. Falling back to the original while
 * a re-trim is outstanding would change the published audio twice for one decision:
 * once back to the untrimmed file, and once forward to the new cut. Serving the copy
 * SelfPod already made changes it once, when the new one is ready.
 *
 * The filename carries the content version, so the row and the bytes it describes move
 * together and a `length` can never advertise a file that is not the one being served.
 */
export function publishedAudio(episode) {
  const trimmed = Boolean(episode.trimmed_filename);

  return {
    isTrimmed: trimmed,
    /** Relative to `/data/.trimmed/{show_id}` when trimmed, else to the show folder. */
    filename: trimmed ? episode.trimmed_filename : episode.filename,
    sizeBytes: trimmed ? (episode.trimmed_bytes ?? null) : (episode.file_size_bytes ?? null),
    durationSeconds: trimmed
      ? (episode.trimmed_duration_seconds ?? null)
      : (episode.duration_seconds ?? null),
    /**
     * The content version for the enclosure URL, or null for an untrimmed episode.
     *
     * Null rather than a digest of the original is deliberate: an episode that has
     * never been trimmed has the URL it has always had, so adding a version to it
     * would give every existing subscriber a "new" enclosure for audio that has not
     * changed, and some apps treat that as a new download.
     */
    version: trimmed ? (episode.trimmed_etag ?? null) : null,
  };
}
