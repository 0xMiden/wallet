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

/** Register a capture in progress. The promise must never reject. */
export function trackScreenCapture(page: Page, work: Promise<unknown>): void {
  let set = inFlight.get(page);
  if (!set) {
    set = new Set();
    inFlight.set(page, set);
  }
  set.add(work);
  void work.finally(() => set?.delete(work));
}

/**
 * Stop screen capture on this page and wait for anything already running.
 *
 * Call before deliberately destroying a page or its whole browser. Capture is
 * diagnostics, but it is not passive: the binding handler drives real
 * Playwright calls (a `waitForFunction`, then a screenshot), and a binding
 * call still being dispatched when the browser dies fails inside Playwright's
 * own object bookkeeping — "Object with guid handle@… was not bound in the
 * connection" — which surfaces as the test's failure even though its body
 * passed. That error is raised while resolving the call, not by the handler, so
 * no amount of `try`/`catch` in the handler can contain it. It has to not be in
 * flight.
 *
 * This is how `guardian-recovery-stress`'s browser-crash spec failed on main:
 * `killBrowser()` landed while a screen change was mid-capture. Both halves
 * matter — removing the binding stops new calls, and settling the in-flight set
 * closes the window between the last call starting and the browser going away.
 */
export async function suspendScreenCapture(page: Page): Promise<void> {
  if (!page.isClosed()) {
    await page
      .evaluate(name => {
        delete (globalThis as unknown as Record<string, unknown>)[name];
      }, SCREEN_CHANGE_BINDING)
      .catch(() => {});
  }
  const set = inFlight.get(page);
  if (set && set.size > 0) {
    await Promise.allSettled([...set]);
  }
}
