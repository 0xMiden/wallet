/**
 * How far above the viewport's bottom edge the peek tray sits: the distance from the top edge of the
 * tab bar's footer (`[data-tabbar-footer]`) to the viewport's bottom, so the tray rests just on top
 * of the bar.
 *
 * The footer sits on the top of the body's safe-area padding, not on the screen edge, so its height
 * is not that distance: its top edge is read in viewport coordinates instead. The footer box itself
 * is never translated (only its inner wrapper slides when the bar hides), so the reading is stable.
 * With no footer, no layout box, or a reading that is not positive, it falls back to the capsule's
 * 58px on a home-indicator iPhone's 34px safe-area floor.
 */
export const FOOTER_CLEARANCE_FALLBACK = 92;

export function measureFooterClearance(footer: Element | null | undefined, viewportHeight: number): number {
  if (!footer) return FOOTER_CLEARANCE_FALLBACK;
  const rect = footer.getBoundingClientRect();
  if (rect.height === 0) return FOOTER_CLEARANCE_FALLBACK;
  const clearance = viewportHeight - rect.top;
  return clearance > 0 ? clearance : FOOTER_CLEARANCE_FALLBACK;
}

/**
 * Reports the footer clearance now, on every window resize and whenever `data-hide-navbar` changes
 * on the body, but only while the bar is at rest. On iOS the keyboard lifts the layout through the
 * body's bottom padding without a resize event, and it always holds the bar hidden
 * (`body[data-hide-navbar]`), so while that flag is set the caller keeps its previous value.
 * Returns the unsubscribe.
 */
export function subscribeFooterClearance(onChange: (clearance: number) => void): () => void {
  const read = () => {
    if (document.body.hasAttribute('data-hide-navbar')) return;
    onChange(measureFooterClearance(document.querySelector('[data-tabbar-footer="true"]'), window.innerHeight));
  };
  read();
  window.addEventListener('resize', read);
  const observer = new MutationObserver(read);
  observer.observe(document.body, { attributeFilter: ['data-hide-navbar'] });
  return () => {
    window.removeEventListener('resize', read);
    observer.disconnect();
  };
}
