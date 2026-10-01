/**
 * How far above the viewport's bottom edge the peek tray sits: the distance from the top edge of the
 * tab bar's footer (`[data-tabbar-footer]`) to the viewport's bottom, so the tray rests just on top
 * of the bar.
 *
 * The footer sits on the top of the body's safe-area padding, not on the screen edge, so its height
 * is not that distance: its top edge is read in viewport coordinates instead. The footer box itself
 * is never translated (only its inner wrapper slides when the bar hides), so the reading is stable.
 * With no footer, no layout box, or a reading that is not positive, it falls back to the capsule's
 * 58px on a home-indicator iPhone's 34px safe-area floor. A footer that mounts after a subscriber
 * is announced by the tab bar (`announceFooterMounted`), since no resize marks its arrival.
 */
export const FOOTER_CLEARANCE_FALLBACK = 92;

export function measureFooterClearance(footer: Element | null | undefined, viewportHeight: number): number {
  if (!footer) return FOOTER_CLEARANCE_FALLBACK;
  const rect = footer.getBoundingClientRect();
  if (rect.height === 0) return FOOTER_CLEARANCE_FALLBACK;
  const clearance = viewportHeight - rect.top;
  return clearance > 0 ? clearance : FOOTER_CLEARANCE_FALLBACK;
}

const liveReads = new Set<() => void>();

/** Called by the tab bar once its footer is in the DOM, so every live subscription reads it. */
export function announceFooterMounted(): void {
  liveReads.forEach(read => read());
}

/**
 * Reports the footer clearance now, on every window resize, whenever `data-hide-navbar` changes
 * on the body and when the footer mounts (`announceFooterMounted`), but only while the bar is at
 * rest. On iOS the keyboard lifts the layout through the body's bottom padding without a resize
 * event, and it always holds the bar hidden (`body[data-hide-navbar]`), so while that flag is set
 * the caller keeps its previous value. With no footer in the DOM it reports nothing either, so the
 * caller keeps its value rather than taking the fallback. Returns the unsubscribe.
 */
export function subscribeFooterClearance(onChange: (clearance: number) => void): () => void {
  const read = () => {
    if (document.body.hasAttribute('data-hide-navbar')) return;
    const footer = document.querySelector('[data-tabbar-footer="true"]');
    if (!footer) return;
    onChange(measureFooterClearance(footer, window.innerHeight));
  };
  liveReads.add(read);
  read();
  window.addEventListener('resize', read);
  const observer = new MutationObserver(read);
  observer.observe(document.body, { attributeFilter: ['data-hide-navbar'] });
  return () => {
    liveReads.delete(read);
    window.removeEventListener('resize', read);
    observer.disconnect();
  };
}
