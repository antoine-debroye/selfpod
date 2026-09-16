/**
 * Every word the advert pages use for a state or a decision, and no others.
 *
 * The pages this replaces had about fifty ways of saying where a stretch of audio
 * stood and twelve button labels for five things the owner could do. Nobody could
 * tell "Removed", "Put it back", "Remove this from every episode" and "Forget it"
 * apart without reading the paragraph under each. So the words live here, frozen, and
 * a test counts them: adding a fifth state or a seventh button is a decision to make
 * on purpose, not something that happens one template at a time.
 */

/** Where one stretch of one episode stands. */
export const STRETCH_STATES = Object.freeze({
  cut: 'Cut',
  waiting: 'Waiting',
  kept: 'Kept',
  restored: 'Restored here',
});

/**
 * Where one episode stands, as the pill in the episode table and as a caption.
 * `pill` is the short form; `caption` the sentence form where there is room.
 */
export const EPISODE_STATES = Object.freeze({
  cut: Object.freeze({ pill: 'cut', caption: 'Cut' }),
  waiting: Object.freeze({ pill: 'waiting', caption: 'Waiting for you.' }),
  held: Object.freeze({ pill: 'held', caption: 'Not in your feed yet.' }),
  listening: Object.freeze({ pill: 'listening', caption: 'Listening…' }),
  clean: Object.freeze({ pill: '—', caption: 'Nothing to cut.' }),
  untouched: Object.freeze({ pill: 'as arrived', caption: 'Published as it arrived.' }),
});

/** The six things the owner can do about adverts. */
export const DECISIONS = Object.freeze({
  remove: 'Remove',
  keep: 'Keep',
  restoreHere: 'Restore here',
  stop: 'Restore everywhere and stop',
  forget: 'Forget',
  teach: 'Teach',
});

/** Buttons that are not decisions about adverts: the settings form's own. */
export const SETTINGS_BUTTONS = Object.freeze(['Save', 'Check now']);

/** Every label a submit button on an advert page may carry. */
export const ALLOWED_BUTTON_LABELS = Object.freeze([...Object.values(DECISIONS), ...SETTINGS_BUTTONS]);

/**
 * Words the old pages used that must not come back. "Put it back" did two different
 * things depending on the card it was on; "heard once" described rows that no longer
 * exist.
 */
export const RETIRED_WORDS = Object.freeze([
  'Already decided',
  'Put it back',
  'Remove this from every episode',
  'heard once',
]);
