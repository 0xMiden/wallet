import vm from 'vm';

/** What Confirmation shows after a create whose first sync failed. */
const FAILED_CONFIRMATION_TEXT = 'Something went wrong\n\nFailed to sync state: RPC deadline exceeded\n\nRetry';

/**
 * How one create attempt ends: `ready-under-failure` is a wallet that turned Ready while the failure Notice was up, and
 * `creating` an attempt that never ends.
 */
export type CreateAttemptOutcome = 'ready' | 'fails' | 'ready-under-failure' | 'creating';

/**
 * Onboarding's Confirmation as the WebView runs it, for unit tests that drive a page's created-wallet wait through
 * its own eval: each create attempt reads `creating` twice, then lands on its outcome; Retry starts the next attempt,
 * and the screen keeps its failure for `lagReads` reads after it (`Infinity`: it never clears).
 */
export function fakeConfirmationApp(
  outcomes: CreateAttemptOutcome[],
  opts: { lagReads?: number; retryButton?: boolean } = {}
): { evalJs: (js: string) => Promise<unknown>; clicks: number[] } {
  let attempt = 0;
  let reads = 0;
  let lag = 0;
  let phase: CreateAttemptOutcome = 'creating';
  const clicks: number[] = [];
  const failed = { innerText: FAILED_CONFIRMATION_TEXT };
  const submit = {
    click: () => {
      clicks.push(attempt);
      attempt++;
      reads = 0;
      lag = opts.lagReads ?? 0;
      if (lag === 0) phase = 'creating';
    }
  };
  const storeReady = (): boolean => phase === 'ready' || phase === 'ready-under-failure';
  const failureShown = (): boolean => phase === 'fails' || phase === 'ready-under-failure';
  const webView = {
    window: {
      __TEST_STORE__: {
        getState: () => ({
          status: storeReady() ? 2 : 0,
          currentAccount: storeReady() ? { publicKey: 'mtst1qcreated' } : null
        })
      }
    },
    document: {
      querySelector: (selector: string) => {
        if (selector.includes('onboarding-confirmation-submit')) return opts.retryButton === false ? null : submit;
        if (selector.includes('onboarding-confirmation-failed')) return failureShown() ? {} : null;
        if (selector.includes('onboarding-confirmation')) return failed;
        return null;
      }
    }
  };
  const evalJs = async (js: string): Promise<unknown> => {
    if (js.includes('__TEST_STORE__')) {
      if (lag > 0 && --lag === 0) phase = 'creating';
      else if (phase === 'creating' && ++reads >= 2) phase = outcomes[attempt] ?? 'fails';
    }
    return vm.runInNewContext(`(function () { ${js} })()`, webView);
  };
  return { evalJs, clicks };
}
