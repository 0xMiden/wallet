const NEXT_KEYS = new Set(['ArrowRight', 'ArrowDown']);
const PREV_KEYS = new Set(['ArrowLeft', 'ArrowUp']);

/**
 * The enabled-position target for an arrow, Home or End key on a radio group, shared by
 * `SegmentedControl` and `ChoiceCardGroup`. `origin` is the enabled position the walk starts from
 * (focused, else selected), or -1 when neither exists. From -1 EITHER walk (NEXT or PREV) lands on
 * the first enabled option (0), never the second: clamping -1 to 0 before adding or subtracting one
 * would do exactly that. The key filter runs before the no-origin fallback, so a key this group does
 * not handle returns `null` regardless of `origin`, rather than falling into the fallback and
 * selecting the first option for a key nobody asked to move. Home and End are absolute and ignore
 * `origin`. Returns `null` for an unhandled key and for `enabledCount` 0 (nothing to land on).
 *
 * LanguageSettings' radiogroup (`app/templates/LanguageSettings.tsx`) is the one group that does not
 * call this: its arrows move focus without selecting, it has no Home or End, and its origin is
 * always the focused row - there is no enabled-position walk or no-origin case to share.
 */
export function radioGroupKeyTarget(key: string, enabledCount: number, origin: number): number | null {
  if (enabledCount === 0) return null;
  if (NEXT_KEYS.has(key)) return origin < 0 ? 0 : (origin + 1) % enabledCount;
  if (PREV_KEYS.has(key)) return origin < 0 ? 0 : (origin - 1 + enabledCount) % enabledCount;
  if (key === 'Home') return 0;
  if (key === 'End') return enabledCount - 1;
  return null;
}
