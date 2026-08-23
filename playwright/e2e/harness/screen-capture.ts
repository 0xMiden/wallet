import type { Page } from '@playwright/test';
import * as path from 'path';

export function screenShotName(seq: number, key: string, label: string): string {
  const slug = key.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'screen';
  const padded = String(seq).padStart(3, '0');
  return `screen-${padded}-${slug}-wallet-${label.toLowerCase()}.png`;
}

export async function captureBestEffort(
  grab: (path: string) => Promise<void>,
  dir: string,
  seq: number,
  key: string,
  label: string
): Promise<void> {
  try {
    await grab(path.join(dir, screenShotName(seq, key, label)));
  } catch {
    // best-effort: page/context may be mid-navigation or torn down
  }
}

export function startScreenPoll(opts: {
  intervalMs: number;
  read: () => Promise<{ key: string; seq: number } | null>;
  grab: (path: string) => Promise<void>;
  dir: string;
  label: string;
}): { stop: () => void } {
  let lastSeq = -1;
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const s = await opts.read();
      if (s && s.seq !== lastSeq) {
        lastSeq = s.seq;
        await captureBestEffort(opts.grab, opts.dir, s.seq, s.key, opts.label);
      }
    } catch {
      // ignore a single bad read
    }
  };
  const timer = setInterval(() => void tick(), opts.intervalMs);
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    }
  };
}

/**
 * The app's reactive screen-change signal (see `src/lib/e2e/screen-key.ts`,
 * emitted only when `MIDEN_E2E_TEST=true`). The fixture exposes a Playwright
 * binding under this name; the app calls it optionally
 * (`globalThis.__e2eScreenChanged?.(...)`), which is what makes the suspension
 * below possible at all — remove the property and the app simply stops calling.
 */
export const SCREEN_CHANGE_BINDING = '__e2eScreenChanged';

/**
 * Handler promises still running per page, so a caller about to destroy the
 * browser can wait for them instead of racing them. A WeakMap so a page that
 * goes away takes its entry with it.
 */
const inFlight = new WeakMap<Page, Set<Promise<unknown>>>();

/** Pages capture must no longer start on. See `suspendScreenCapture`. */
const suspended = new WeakSet<Page>();

/** Register a capture in progress. */
export function trackScreenCapture(page: Page, work: Promise<unknown>): void {
  let tracked = inFlight.get(page);
  if (!tracked) {
    tracked = new Set();
    inFlight.set(page, tracked);
  }
  const set = tracked;
  set.add(work);
  // `.finally()` re-raises a rejection and `void` attaches no handler, so an
  // unhandled rejection here would be charged to the running test — the exact
  // failure class this module exists to prevent. Callers are asked not to pass
  // a rejecting promise; this makes it harmless if one ever does.
  //
  // Deliberately untested, rather than tested badly. An absence of unhandled
  // rejections is not observable from a jest test here: the sandbox's `process`
  // is not the real one, so a listener never fires, and jest does not fail the
  // test on it either — verified by removing this `.catch()` and watching all
  // tests stay green. Any assertion written for it would pass regardless.
  void work.finally(() => set.delete(work)).catch(() => {});
}

/**
 * Whether capture has been switched off for this page.
 *
 * The handler consults this. `suspendScreenCapture` sets it synchronously,
 * before it awaits anything, and every handler invocation is dispatched on the
 * Node event loop strictly afterwards — so a binding call the page had already
 * made cannot slip past it, however the two messages happen to be ordered on
 * the wire. That is what makes the guarantee below a guarantee rather than a
 * narrow window, and it makes the property delete an optimisation rather than
 * load-bearing.
 */
export function isScreenCaptureSuspended(page: Page): boolean {
  return suspended.has(page);
}

/**
 * How long the handler may wait for the page to have painted before it gives up
 * on a frame. Lives here, next to the drain, because the two are coupled — see
 * `DRAIN_TIMEOUT_MS`.
 */
export const BLANK_FRAME_WAIT_MS = 1500;

/**
 * Cap on the drain, in case a tracked capture never settles.
 *
 * MUST exceed `BLANK_FRAME_WAIT_MS`, and that is the whole reason abandoning
 * the drain is safe. The handler makes exactly one call whose reply names a
 * handle — the `waitForFunction` — and it is bounded by that wait, so it has
 * always settled by the time the drain gives up. What can still be outstanding
 * is the screenshot, whose reply carries image bytes and no handle, and so
 * cannot produce the failure this module exists to prevent.
 *
 * Derived rather than written as a literal: as two independent numbers, raising
 * the wait past the drain would silently restore the original bug, with the
 * fix still looking intact.
 */
const DRAIN_TIMEOUT_MS = BLANK_FRAME_WAIT_MS * 2;

/** Resolve when `work` does, or after `DRAIN_TIMEOUT_MS`, whichever is first. */
async function withDeadline(work: Promise<unknown>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    work,
    new Promise(resolve => {
      timer = setTimeout(resolve, DRAIN_TIMEOUT_MS);
    })
  ]);
  if (timer) clearTimeout(timer);
}

/**
 * Stop screen capture on this page and wait for anything already running.
 *
 * Call before deliberately destroying a page or its whole browser. Capture is
 * diagnostics, but it is not passive: the handler answers each screen change
 * with real Playwright calls — a `waitForFunction`, then a screenshot. Destroy
 * the browser while one of those is outstanding and its reply arrives naming a
 * handle the client has already discarded, which fails inside Playwright's own
 * object bookkeeping as "Object with guid handle@… was not bound in the
 * connection". Playwright charges that to whatever test is running.
 *
 * A `try`/`catch` around the handler cannot contain it. The throw happens while
 * the client validates the inbound reply, not in the code that made the call,
 * and lands as an uncaught exception with the internal frames stripped — which
 * is why it arrives with no stack and nothing in the spec to point at. The call
 * has to not be outstanding.
 *
 * This is how `guardian-recovery-stress`'s browser-crash spec failed on main.
 * Not inferred — the trace from run 32640782490 leaves six actions open, and
 * exactly one of them can name a handle: the handler's own `waitForFunction`,
 * with `Close browser` from `killBrowser()` logged right after it. (The other
 * five are four `page.evaluate`s from network-capture, whose replies carry a
 * serialized value, and the close itself.) The error the trace records names
 * the same guid the CI log reported.
 *
 * Both halves matter: the suspend flag stops further captures starting, and
 * draining the in-flight set covers the ones already under way — for the
 * handle-producing call, in full; see `DRAIN_TIMEOUT_MS`.
 *
 * One-way, and deliberately so: every caller is discarding the page. Calling
 * `installScreenCapture` again on a suspended page will NOT revive it — the
 * binding is still registered, so re-exposing it throws and is swallowed, and
 * the flag stays set. Capture belongs to a fresh `Page`.
 */
export async function suspendScreenCapture(page: Page): Promise<void> {
  suspended.add(page);
  if (!page.isClosed()) {
    // `page.evaluate` takes no timeout, and this now runs on the teardown path
    // of every test as well as before a deliberate kill — so a wedged renderer,
    // exactly what a crash-stress spec produces, would stall teardown until the
    // suite timeout. Bounded because it is inessential: the flag above already
    // does the work, and this only spares the page a call it would no-op.
    // (`harness/fetch-faults.ts` bounds its own arming evaluate for the same
    // reason.)
    await withDeadline(
      page
        .evaluate(name => {
          delete (globalThis as unknown as Record<string, unknown>)[name];
        }, SCREEN_CHANGE_BINDING)
        .catch(() => {})
    );
  }
  const set = inFlight.get(page);
  if (set && set.size > 0) {
    // Bounded, because a capture caught by the very race above never settles:
    // the client drops its callback before it throws, so that promise is
    // waited on forever. Unbounded, a residual loss there would trade a
    // spurious failure for a test-timeout hang, which is the worse diagnostic.
    await withDeadline(Promise.allSettled([...set]));
    // So a second suspend on this page does not wait out the deadline again for
    // work already abandoned. `killBrowser()` then `reopen()` does exactly that.
    // Nothing can re-add: the handler consults the flag before it tracks, and
    // suspension is one-way.
    set.clear();
  }
}
