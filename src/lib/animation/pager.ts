/** Motion tunables for the Home pager: tap-to-page animation, scroll settle and gesture priority. */
export const pagerMotion = {
  /** Tap (FLIP) curve: cubic fit to the critically damped k 385 / c 39 spring from rest. */
  tapEasing: 'cubic-bezier(0.35, 0.6, 0.25, 1)',
  tapBaseMs: 380,
  tapPerExtraPageMs: 40,
  tapMaxMs: 500,
  /** Settle fallback when `scrollend` is missing: idle time with no touch down. */
  settleIdleMs: 120,
  /** A scroller within this many px of a page boundary counts as aligned. */
  alignTolerancePx: 1,
  /** Longest a held gesture may defer background work before it runs anyway. */
  interactionDeferCapMs: 1500
} as const;

/** Tap animation length for a jump of `pagesMoved` pages: the base plus a step per extra page, capped. */
export function pagerTapDurationMs(pagesMoved: number): number {
  const extra = Math.max(0, pagesMoved - 1);
  return Math.min(pagerMotion.tapMaxMs, pagerMotion.tapBaseMs + pagerMotion.tapPerExtraPageMs * extra);
}
