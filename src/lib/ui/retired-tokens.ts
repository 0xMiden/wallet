/**
 * Colour tokens removed from `tailwind.config.ts`, with the replacement each call site should take.
 * Add a name here in the same change that deletes it from the config.
 *
 * `retired-tokens.test.ts` consumes this: it asserts no source file still uses one, and that none is
 * still declared in the config. The value is a plain string on purpose - it is interpolated straight
 * into that suite's offence line, so an object here would render `-> use [object Object]` and
 * silently destroy the guard's only diagnostic, with nothing to catch it (a template literal accepts
 * any type, and the message is never rendered while the suite is green).
 */
export const RETIRED_COLOUR_TOKENS: Record<string, string> = {
  'heading-gray': 'ink (or muted where the text really is secondary)',
  'gray-25': 'fill',
  'gray-50': 'fill',
  'surface-input': 'fill',
  'surface-interactive': 'fill',
  'surface-nav-button': 'fill',
  'button-secondary': 'fill',
  'button-secondary-hover': 'fill-pressed',
  // Retired by the balance-card redesigns: the muted ink went, and the footer's divider and then its
  // hairline gave way to the footer's own darker well, the card's second tone.
  'surface-balance-fg-muted': 'surface-balance-fg',
  'surface-balance-divider': 'surface-balance-footer',
  'surface-balance-rule': 'surface-balance-footer',
  'card-slate-deep': 'card-slate',
  'card-orange-deep': 'card-orange',
  'card-blue-deep': 'card-blue',
  'card-green-deep': 'card-green',
  'card-purple-deep': 'card-purple',
  // Overview is a tab colour, not a flow: it never had a surface or text of its own to tint.
  'action-overview-tint': 'action-overview (the bare colour; only a flow has a tint)',
  'action-overview-ink': 'action-overview (the bare colour; only a flow has an ink)'
};

/**
 * The CSS custom property each retired token was backed by, consumed by `design-tokens.test.ts` to
 * assert the variable is gone from `main.css`. A second map rather than a widened value, so the
 * offence-line interpolation above keeps a string.
 *
 * Three of these are NOT derivable from the token name, which is why they are carried rather than
 * computed. PROVENANCE, stated because it is weaker than it looks: all eight variables are absent
 * from `main.css` today, so the live files can only confirm the ABSENCE, never the pairing. The
 * pairings come from the assertions this map replaces - `design-tokens.test.ts` paired 25/50 with
 * `color-surface-(secondary|tertiary)` and `heading-gray` with `color-text-secondary`. A mistyped
 * entry here would pass forever, since every one is asserted only by absence.
 */
export const RETIRED_TOKEN_CSS_VARS: Record<string, string> = {
  'heading-gray': 'color-text-secondary',
  'gray-25': 'color-surface-secondary',
  'gray-50': 'color-surface-tertiary',
  'surface-input': 'surface-input',
  'surface-interactive': 'surface-interactive',
  'surface-nav-button': 'surface-nav-button',
  'button-secondary': 'surface-button-secondary',
  'button-secondary-hover': 'surface-button-secondary-hover',
  'surface-balance-fg-muted': 'surface-balance-fg-muted',
  'surface-balance-rule': 'surface-balance-rule',
  'card-slate-deep': 'card-slate-deep',
  'card-orange-deep': 'card-orange-deep',
  'card-blue-deep': 'card-blue-deep',
  'card-green-deep': 'card-green-deep',
  'card-purple-deep': 'card-purple-deep',
  'action-overview-tint': 'action-overview-tint',
  'action-overview-ink': 'action-overview-ink',
  // This one never had a variable: it was a literal (#FFFFFF4D) in the config. It is listed because
  // the two maps are pinned 1:1, and what this map really asserts is "no variable by this name is
  // declared" - trivially true here, and it keeps the colour half of the guard.
  'surface-balance-divider': 'surface-balance-divider'
};

/**
 * Escapes every regex metacharacter, not just the hyphen (which needs none outside a character
 * class). Lives here so both suites share one copy: a future key like `grey.400` would otherwise
 * make `.` match any character, and one containing `(` would add a capture group and shift the
 * group index the offence line reads.
 */
export function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
}
