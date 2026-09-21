/**
 * Colour tokens removed from `tailwind.config.ts`, with the replacement each call site should take.
 * Add a name here in the same change that deletes it from the config.
 *
 * This lives in its own module, not beside either test, because two suites assert against it:
 * `retired-tokens.test.ts` owns "no source file still uses one" and "none is still declared in the
 * config", and `design-tokens.test.ts` owns the CSS-variable side in `main.css`. Keeping one list
 * is the point - the invariant was previously asserted twice from two hand-maintained lists in two
 * non-equivalent regex dialects, so a double-quoted re-add was caught by one and missed by the
 * other, and retiring a token meant editing four places.
 */
export const RETIRED_COLOUR_TOKENS: Record<string, string> = {
  'heading-gray': 'ink (or muted where the text really is secondary)',
  'gray-25': 'fill',
  'gray-50': 'fill',
  'surface-input': 'fill',
  'surface-interactive': 'fill',
  'surface-nav-button': 'fill',
  'button-secondary': 'fill',
  'button-secondary-hover': 'fill-pressed'
};
