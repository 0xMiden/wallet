/** Confirmation's button: "Open wallet", and Retry while the screen shows a failure (see `passImportConfirmation`). */
export const CONFIRMATION_SUBMIT = '[data-testid="onboarding-confirmation-submit"]';

export interface CreatedWalletState {
  ready: boolean;
  /** The failure screen's text while Confirmation shows it, else null. */
  failed: string | null;
}

// Ready as the create has always waited for it, else Confirmation's failure screen (Confirmation.tsx marks it).
export const CREATED_WALLET_STATE_JS =
  `var s = window.__TEST_STORE__; var st = s && s.getState(); ` +
  `if (st && (st.status === 2 || st.status === 'Ready') && st.currentAccount) return { ready: true, failed: null }; ` +
  `var f = document.querySelector('[data-testid="onboarding-confirmation-failed"]'); ` +
  `if (!f) return { ready: false, failed: null }; ` +
  `var screen = document.querySelector('[data-testid="onboarding-confirmation"]') || f; ` +
  `return { ready: false, failed: (screen.innerText || screen.textContent || '').trim() };`;

export interface CreatedWalletReadyWait {
  /** Names the create in every error. */
  label: string;
  timeoutMs: number;
  /** The page's poll: resolves once `accept` takes a read, rejects at the deadline or with what `accept` throws. */
  poll: (js: string, timeoutMs: number, accept: (state: CreatedWalletState) => Promise<boolean>) => Promise<void>;
  pressRetry: () => Promise<void>;
}

/**
 * Waits for a created wallet to read Ready, for every mobile page that clicks Confirmation's "Open wallet". A create
 * whose first sync fails leaves Confirmation's failure screen up, which no Ready budget outlasts: the first time it
 * shows, this presses the app's own Retry and keeps waiting; a failure after that fails at once with what the screen
 * says, and a screen that never clears after the Retry fails at the deadline with it.
 */
export async function pollCreatedWalletReady({
  label,
  timeoutMs,
  poll,
  pressRetry
}: CreatedWalletReadyWait): Promise<void> {
  // Written inside the poll's callback, so kept off `let`s that the initializer would narrow.
  const seen: { retried: boolean; cleared: boolean; stillFailed: string | null } = {
    retried: false,
    cleared: false,
    stillFailed: null
  };
  try {
    await poll(CREATED_WALLET_STATE_JS, timeoutMs, async state => {
      seen.stillFailed = null;
      if (state.ready) return true;
      if (state.failed === null) {
        seen.cleared = seen.retried;
        return false;
      }
      const screen = state.failed.replace(/\s+/g, ' ').slice(0, 500);
      if (!seen.retried) {
        seen.retried = true;
        await pressRetry().catch((error: unknown) => {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`${label}: wallet creation failed and its Retry could not be pressed (${reason}): ${screen}`);
        });
        return false;
      }
      // Until a read shows the screen without its failure, the Retry has not started and this is still the first one.
      if (!seen.cleared) {
        seen.stillFailed = screen;
        return false;
      }
      throw new Error(`${label}: wallet creation failed again after one Retry: ${screen}`);
    });
  } catch (error) {
    // A Retry that failed before any read saw it start, or one that did nothing, ends at the deadline.
    if (seen.stillFailed === null) throw error;
    throw new Error(`${label}: wallet creation still shows its failure screen after one Retry: ${seen.stillFailed}`);
  }
}
