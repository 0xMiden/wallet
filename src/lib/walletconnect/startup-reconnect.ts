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
 * So the restore is given `STARTUP_RECONNECT_BOUND_MS`. When it is still `connecting` at the bound and the user has
 * not opened the connect modal, the stored session is forgotten, so the next page load starts `disconnected`, a
 * disconnect is asked of AppKit, and the hook reads the status as `disconnected` from then on, because the
 * disconnect itself can wait on the same stuck provider. Import-free, so it can be tested without AppKit.
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

/** True while the startup restore has passed its bound and AppKit still reports `connecting`. */
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
  let modalOpened = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stopTimer = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };
  const fire = () => {
    timer = undefined;
    if (status !== 'connecting' || modalOpened) return;
    publish(true);
    try {
      deps.forgetSession();
    } catch (error) {
      console.warn('[walletconnect] could not forget the stored session', error);
    }
    deps.disconnect().catch(error => console.warn('[walletconnect] startup reconnect disconnect failed', error));
  };
  timer = setTimeout(fire, STARTUP_RECONNECT_BOUND_MS);

  const unsubscribeStatus = deps.subscribeStatus(next => {
    status = next;
    // A restore that settles, or a connect the user made, ends the bound and the override alike.
    if (next !== 'connecting') {
      stopTimer();
      publish(false);
    }
  });
  const unsubscribeModal = deps.subscribeModalOpen(open => {
    if (!open) return;
    // The user took over: AppKit's own connect flow sets and clears `connecting` from here.
    modalOpened = true;
    stopTimer();
  });

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
