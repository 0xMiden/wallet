/**
 * A bound on AppKit's startup reconnect.
 *
 * When a page loads, AppKit reads the connection status it stored on the last connect. On `connected` it sets the
 * EVM account status to `connecting` before any user action and restores the old WalletConnect session through the
 * relay. The status moves on only when that restore settles. A stale session (its peer gone, its pairing expired)
 * can keep the restore open for the life of the page, and the wallet then shows "Preparing connection…" with its
 * connect button disabled, so the user can neither finish nor start a connection. A fresh install has no stored
 * status, which is why only old installs are hit.
 *
 * So the restore is given `STARTUP_RECONNECT_BOUND_MS`, counted only while the connect modal is closed. When it is
 * still `connecting` at the bound, the stored session is forgotten, so the next page load starts `disconnected`, a
 * disconnect is asked of AppKit, and the hook reads `connecting` as `disconnected`, because the disconnect itself
 * can wait on the same stuck provider. Opening the modal is the user taking over: it pauses the bound and lifts that
 * override, so their own attempt shows its progress. Closing the modal while the restore has still not settled
 * starts a fresh bound. The first status other than `connecting` settles the restore for good. Import-free, so it
 * can be tested without AppKit.
 */
import type { ConnectionStatus } from '@reown/appkit-controllers';

export const STARTUP_RECONNECT_BOUND_MS = 10_000;

export interface StartupReconnectDeps {
  /** The status AppKit stored on the last connect, if any. */
  storedStatus: () => ConnectionStatus | undefined;
  /** AppKit's EVM account status, on every change. */
  subscribeStatus: (listener: (status: string | undefined) => void) => () => void;
  /** Whether AppKit's modal is open, on every change. */
  subscribeModalOpen: (listener: (open: boolean) => void) => () => void;
  /** Forget the stored session, so the next page load starts disconnected. */
  forgetSession: () => void;
  /** Ask AppKit to end the restore. May never settle. */
  disconnect: () => Promise<void>;
}

let timedOut = false;
const listeners = new Set<() => void>();

function publish(next: boolean): void {
  if (timedOut === next) return;
  timedOut = next;
  listeners.forEach(listener => listener());
}

/** True while an unsettled startup restore has passed its bound and the connect modal has not been opened since. */
export function startupReconnectTimedOut(): boolean {
  return timedOut;
}

export function subscribeStartupReconnect(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The status the wallet shows for AppKit's: a timed-out startup `connecting` reads as `disconnected`. */
export function effectiveAppKitStatus(status: string | undefined): string | undefined {
  return timedOut && status === 'connecting' ? 'disconnected' : status;
}

/**
 * Bound the startup restore. Does nothing unless AppKit stored `connected`. Returns a function that stops watching.
 */
export function boundStartupReconnect(deps: StartupReconnectDeps): () => void {
  if (deps.storedStatus() !== 'connected') return () => {};
  let status: string | undefined = 'connecting';
  let settled = false;
  let modalOpen = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stopTimer = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };
  const fire = () => {
    timer = undefined;
    if (settled || modalOpen || status !== 'connecting') return;
    publish(true);
    try {
      deps.forgetSession();
    } catch (error) {
      console.warn('[walletconnect] could not forget the stored session', error);
    }
    deps.disconnect().catch(error => console.warn('[walletconnect] startup reconnect disconnect failed', error));
  };
  // A running clock keeps its deadline; `fire` never re-arms.
  const arm = () => {
    if (settled || modalOpen || status !== 'connecting' || timer !== undefined) return;
    timer = setTimeout(fire, STARTUP_RECONNECT_BOUND_MS);
  };

  const unsubscribeStatus = deps.subscribeStatus(next => {
    status = next;
    // The first status other than `connecting` settles the restore: a later `connecting` is the user's own.
    if (next !== 'connecting') {
      settled = true;
      stopTimer();
      publish(false);
    }
  });
  const unsubscribeModal = deps.subscribeModalOpen(open => {
    if (open) {
      // The user took over: show their attempt's own `connecting`, even with an earlier disconnect still pending.
      modalOpen = true;
      stopTimer();
      publish(false);
      return;
    }
    if (!modalOpen) return;
    modalOpen = false;
    arm();
  });
  arm();

  return () => {
    stopTimer();
    unsubscribeStatus();
    unsubscribeModal();
  };
}

export function __resetStartupReconnectForTest(): void {
  timedOut = false;
  listeners.clear();
}
