/**
 * A bound on AppKit's startup reconnect.
 *
 * When a page loads, AppKit reads the connection status it stored on the last connect. On `connected` it sets the
 * EVM account status to `connecting` before any user action and restores the old WalletConnect session through the
 * relay. The status moves on only when that restore settles. A restore that never leaves `connecting` can keep the
 * page on "Preparing connection…" with Connect disabled. A fresh install has no stored status, which is why only old
 * installs are hit.
 *
 * Elapsed time has no proof the peer is stale, so the ten-second bound only frees Connect. `fire` keeps the guard
 * `settled || modalOpen || status !== 'connecting'`, calls `publish(true)`, and returns. It does not touch AppKit's
 * storage or connection, it does not warn, and it does not set `settled`. The first status other than
 * `connecting`, including a `connected` that arrives after the bound, sets `settled`, stops the timer, and calls
 * `publish(false)`. That path does not clear storage or disconnect, so the connection status, connector id, and
 * namespace stay, and `modal.disconnect` is not asked. A restore that reports `connected` after the bound clears the
 * override, and the session kept is the one AppKit restored.
 *
 * A restore that never leaves `connecting` stays stored, so the next page load waits ten seconds again before
 * Connect is freed. That repeated wait is the cost of keeping a session the bound cannot prove is dead. On this
 * page, while the override is set, `effectiveAppKitStatus('connecting')` is `disconnected`, so Connect is not held
 * by the restore. Opening the modal pauses the timer and clears the override. Closing the modal starts a display
 * bound whose expiry does not forget or disconnect a pairing that is still `connecting`; the same `fire` only
 * publishes the override, and a later `connected` clears it and keeps the pairing. Import-free, so it can be tested
 * without AppKit.
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
}

let timedOut = false;
const listeners = new Set<() => void>();

function publish(next: boolean): void {
  if (timedOut === next) return;
  timedOut = next;
  listeners.forEach(listener => listener());
}

/** The display override is on. A later close can set it again. It does not mean the session was removed. */
export function startupReconnectTimedOut(): boolean {
  return timedOut;
}

export function subscribeStartupReconnect(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The status the wallet shows for AppKit's: a timed-out startup `connecting` reads as `disconnected`. That reading
 * does not clear storage or disconnect.
 */
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
      // The user took over: pause the bound and clear the display override, without settling the restore.
      modalOpen = true;
      stopTimer();
      publish(false);
      return;
    }
    if (!modalOpen) return;
    modalOpen = false;
    // Closing starts a display bound. Its expiry does not forget or disconnect a pairing that is still connecting.
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
