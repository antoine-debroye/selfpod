import { SEGMENT_KINDS, SEGMENT_SOURCES } from '../constants.js';

/**
 * The kind of a catalogue row, read from the evidence 1.8 left in it (spec §19.8).
 *
 * The same rule migration 011 applied once, kept as code for two callers: a detector
 * that has not been told a kind, and a pass reconciling rows an older image wrote after
 * a rollback — which cannot know about `kind` and leaves the column at its default.
 */
export function inferKind({ signature = '', source = null, cues = null } = {}) {
  if (signature.startsWith('marker:')) return SEGMENT_KINDS.BOUNDARY_WORDS;
  if (signature.startsWith('anchor:')) return SEGMENT_KINDS.JINGLE;
  if (source === SEGMENT_SOURCES.DIFF) return SEGMENT_KINDS.DIFF;
  if (source === SEGMENT_SOURCES.TRANSCRIPT) {
    return cues === null || cues === undefined ? SEGMENT_KINDS.REMEMBERED_WORDS : SEGMENT_KINDS.REPEATED_WORDS;
  }
  return SEGMENT_KINDS.REPEATED_AUDIO;
}

/** Kinds a person made, rather than a detector: never re-labelled by a later find. */
export const OWNER_KINDS = Object.freeze([
  SEGMENT_KINDS.REMEMBERED_WORDS,
  SEGMENT_KINDS.TAUGHT_RANGE,
]);

/** Kinds that are a rule's cut rather than something found. */
export const RULE_KINDS = Object.freeze([SEGMENT_KINDS.JINGLE, SEGMENT_KINDS.BOUNDARY_WORDS]);

/** Kinds matched in a later episode by their words. */
export const WORD_KINDS = Object.freeze([
  SEGMENT_KINDS.REMEMBERED_WORDS,
  SEGMENT_KINDS.REPEATED_WORDS,
]);
