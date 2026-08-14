/**
 * A tiny event bus that asks the claimable-notes hooks to revalidate NOW,
 * decoupled from their 5s SWR timer.
 *
 * On iOS, a received note is imported only by `useSyncTrigger`'s `syncState`
 * (a ~3s poll) and then surfaced by a SEPARATE claimable-notes SWR (5s refresh),
 * so a freshly-imported note can sit invisible for up to that 5s gap — worse
 * after a WKWebView background-freeze suspends the timers (#462). Firing this
 * right after a sync completes (and on app foreground) lets the note surface as
 * soon as it's imported instead of waiting out the SWR interval.
 *
 * Kept in its own module so both `useSyncTrigger` (producer) and
 * `claimable-notes` (consumer) can import it without a cycle.
 */

const listeners = new Set<() => void>();

/** Ask every subscribed claimable-notes hook to revalidate immediately. */
export function requestNotesRefresh(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A single misbehaving subscriber must not stop the others.
    }
  }
}

/** Subscribe to note-refresh requests; returns an unsubscribe fn. */
export function onNotesRefresh(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
