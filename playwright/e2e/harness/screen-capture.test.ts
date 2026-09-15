import type { Page } from '@playwright/test';

import {
  isScreenCaptureSuspended,
  screenShotName,
  startScreenPoll,
  suspendScreenCapture,
  trackScreenCapture
} from './screen-capture';

describe('screenShotName', () => {
  it('zero-pads seq and slugifies the key', () => {
    expect(screenShotName(4, '/send > SelectAmount > drawer:token', 'A')).toBe(
      'screen-004-send-SelectAmount-drawer-token-wallet-a.png'
    );
  });
});

describe('startScreenPoll', () => {
  it('grabs once per seq change, not on unchanged reads', async () => {
    jest.useFakeTimers();
    const grabs: string[] = [];
    let state: { key: string; seq: number } | null = { key: '/a', seq: 1 };
    const poll = startScreenPoll({
      intervalMs: 100,
      read: async () => state,
      grab: async p => {
        grabs.push(p);
      },
      dir: '/out',
      label: 'A'
    });
    await jest.advanceTimersByTimeAsync(100); // seq 1 -> grab
    await jest.advanceTimersByTimeAsync(100); // unchanged -> no grab
    state = { key: '/b', seq: 2 };
    await jest.advanceTimersByTimeAsync(100); // seq 2 -> grab
    poll.stop();
    expect(grabs).toEqual(['/out/screen-001-a-wallet-a.png', '/out/screen-002-b-wallet-a.png']);
    jest.useRealTimers();
  });

  it('keeps a single read in flight when reads outlast the interval', async () => {
    jest.useFakeTimers();
    let inFlight = 0;
    let maxInFlight = 0;
    let reads = 0;
    let release: (() => void) | undefined;
    const poll = startScreenPoll({
      intervalMs: 100,
      read: async () => {
        reads++;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>(resolve => {
          release = resolve;
        });
        inFlight--;
        return null;
      },
      grab: async () => undefined,
      dir: '/out',
      label: 'A'
    });

    // Ten intervals pass while the first read is still outstanding.
    await jest.advanceTimersByTimeAsync(1_000);
    expect(reads).toBe(1);
    expect(maxInFlight).toBe(1);

    release?.();
    await jest.advanceTimersByTimeAsync(100);
    expect(reads).toBe(2);
    expect(maxInFlight).toBe(1);

    poll.stop();
    release?.();
    jest.useRealTimers();
  });
});

/** Only the two members `suspendScreenCapture` touches. */
const fakePage = (isClosed = false): Page =>
  ({ isClosed: () => isClosed, evaluate: async () => undefined }) as unknown as Page;

/** Yield long enough for an awaited promise chain to drain, not just one hop. */
const flushMacrotasks = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

describe('suspendScreenCapture', () => {
  it('suspends before it awaits anything, so a call already queued cannot slip past', () => {
    const page = fakePage();
    expect(isScreenCaptureSuspended(page)).toBe(false);
    // Deliberately not awaited: the flag has to be set by the synchronous
    // prefix. If it were only set after the `page.evaluate`, a handler
    // invocation dispatched in between would go ahead and issue Playwright
    // calls into a browser about to be destroyed -- the whole bug.
    const pending = suspendScreenCapture(page);
    expect(isScreenCaptureSuspended(page)).toBe(true);
    return pending;
  });

  it('waits for a capture already in flight rather than racing it', async () => {
    const page = fakePage();
    let release = (): void => {};
    trackScreenCapture(
      page,
      new Promise<void>(resolve => {
        release = resolve;
      })
    );

    let settled = false;
    const pending = suspendScreenCapture(page).then(() => {
      settled = true;
    });
    // A macrotask, not `await Promise.resolve()`: one microtask only gets as far
    // as the `page.evaluate` this is parked on, so a `settled === false` there
    // would hold even with the drain removed entirely, and the test would be
    // asserting nothing. Getting past the evaluate is what makes the check below
    // about the drain.
    await flushMacrotasks();
    expect(settled).toBe(false);

    release();
    await pending;
    expect(settled).toBe(true);
  });

  it('does not wait out the deadline a second time for work it already abandoned', async () => {
    jest.useFakeTimers();
    const page = fakePage();
    trackScreenCapture(page, new Promise(() => {}));
    let first = false;
    void suspendScreenCapture(page).then(() => {
      first = true;
    });
    await jest.advanceTimersByTimeAsync(3001);
    expect(first).toBe(true);

    // `killBrowser()` then `reopen()` suspends the same page twice. Without the
    // set being emptied on the way out, the second call would wait out the full
    // deadline again for a capture already given up on.
    let settled = false;
    void suspendScreenCapture(page).then(() => {
      settled = true;
    });
    // Far short of the 3s deadline, so this only passes if the second call
    // found nothing to wait for.
    await jest.advanceTimersByTimeAsync(100);
    expect(settled).toBe(true);
    jest.useRealTimers();
  });

  it('gives up on a capture that never settles instead of hanging', async () => {
    jest.useFakeTimers();
    const page = fakePage();
    // The shape the race itself produces: Playwright drops the call's callback
    // before it throws, so the handler's promise is waited on forever. An
    // unbounded drain would turn a spurious failure into a test-timeout hang.
    trackScreenCapture(page, new Promise(() => {}));
    let settled = false;
    void suspendScreenCapture(page).then(() => {
      settled = true;
    });
    await jest.advanceTimersByTimeAsync(2999);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(2);
    expect(settled).toBe(true);
    jest.useRealTimers();
  });

  it('skips the page evaluate once the page is already closed', async () => {
    const page = fakePage(true);
    const evaluate = jest.fn();
    (page as unknown as { evaluate: unknown }).evaluate = evaluate;
    await suspendScreenCapture(page);
    expect(evaluate).not.toHaveBeenCalled();
    expect(isScreenCaptureSuspended(page)).toBe(true);
  });
});
