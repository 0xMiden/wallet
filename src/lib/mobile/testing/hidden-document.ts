/**
 * Test-only: drives page visibility the way a mobile WebView does, for every
 * test of code that reads `document.hidden`. Never import it from production
 * code.
 */
export interface HiddenDocument {
  /**
   * Override `document.hidden` and fire `visibilitychange`, unless
   * `dispatch: false` models a change whose event never arrives.
   */
  setHidden(hidden: boolean, options?: { dispatch?: boolean }): void;
  /**
   * Model a WebView frozen for `ms` while hidden, under jest's modern fake
   * timers: `performance.now()` and `Date.now()` both move `ms`, and every timer
   * that came due inside the window runs once, at its end, as on resume.
   */
  freezeFor(ms: number): void;
  /** Remove the `document.hidden` override. */
  restore(): void;
}

export function installHiddenDocument(): HiddenDocument {
  let hidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  return {
    setHidden(value, { dispatch = true } = {}) {
      hidden = value;
      if (dispatch) document.dispatchEvent(new Event('visibilitychange'));
    },
    freezeFor(ms) {
      if (!hidden) throw new Error('freezeFor needs a hidden document: call setHidden(true) first');
      // jest.advanceTimersByTime would run an interval once per period; the fake clock's jump
      // collapses every overdue run into one, which is what a frozen WebView does.
      (setTimeout as unknown as { clock: { jump(ms: number): number } }).clock.jump(ms);
    },
    restore() {
      Reflect.deleteProperty(document, 'hidden');
    }
  };
}
