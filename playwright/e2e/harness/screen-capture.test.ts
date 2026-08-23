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
});

/** Only the two members `suspendScreenCapture` touches. */
const fakePage = (isClosed = false): Page =>
  ({ isClosed: () => isClosed, evaluate: async () => undefined }) as unknown as Page;

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
    let released = false;
    let release = (): void => {};
    const work = new Promise<void>(resolve => {
      release = () => {
        released = true;
        resolve();
      };
    });
    trackScreenCapture(page, work);

    let settled = false;
    const pending = suspendScreenCapture(page).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    release();
    await pending;
    expect(released).toBe(true);
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

  it('does not let a rejecting tracked promise reach the test as an unhandled rejection', async () => {
    const page = fakePage();
    trackScreenCapture(page, Promise.reject(new Error('capture blew up')));
    await expect(suspendScreenCapture(page)).resolves.toBeUndefined();
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
