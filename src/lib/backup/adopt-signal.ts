/**
 * The backup signals that the wallet's own machinery raises (architecture doc
 * 7.3): a Guardian sync adopted a newer state, a transaction row reached
 * Completed. Both can happen in a realm other than the backend's. The Guardian
 * sync tick runs in the frontend (`useSyncTrigger`, the extension popup
 * included) and in the backend (the transaction loop); the transaction loop
 * runs in the backend realms. The backup keys live only in the backend realm.
 * So:
 * - A backend realm installs a handler at start (`Actions.init`), and a
 *   signal calls it directly.
 * - A realm with no handler (the extension popup) forwards the signal to the
 *   backend as a `BackupRefreshRequest`.
 *
 * The base URL comes from the network's wallet-config document, and a signal
 * can be raised before this realm hydrated its bridge config. So the check
 * here is only a cheap early exit: it drops a signal only when this realm's
 * snapshot has settled and gives no base URL. While the snapshot still loads,
 * the signal goes on, and the refresh it reaches (`runBackupRefresh`) waits
 * for the backend's hydration and makes the real check.
 *
 * This module is a leaf on purpose: it imports no vault, store or session, so
 * the Guardian and transaction modules can import it in every realm.
 */
import type { IIntercomClient } from 'lib/intercom/client';
import { getBridgeConfigSnapshot } from 'lib/remote-config/runtime';
import { type BackupRefreshReason, type BackupRefreshRequest, WalletMessageType } from 'lib/shared/types';

import { isWalletApiEnabled } from './api-client';

/** The reasons the wallet's own machinery raises; the others come from the UI. */
export type BackupSignalReason = Extract<BackupRefreshReason, 'guardian-adopt' | 'transaction-completed'>;

type SignalHandler = (reason: BackupSignalReason) => void;

let handler: SignalHandler | null = null;

/** Install the backend realm's handler, or remove it with null. */
export function installBackupSignalHandler(next: SignalHandler | null): void {
  handler = next;
}

/** False only when this realm's bridge config has settled and gives no base URL. */
function mayBeEnabled(): boolean {
  return isWalletApiEnabled() || getBridgeConfigSnapshot().status === 'loading';
}

/** Hand `reason` to the handler, or forward it to the backend. Never throws, never waits. */
function signal(reason: BackupSignalReason, label: string): void {
  try {
    if (!mayBeEnabled()) return;
    if (handler !== null) {
      handler(reason);
      return;
    }
    const request: BackupRefreshRequest = { type: WalletMessageType.BackupRefreshRequest, reason };
    getForwarder()
      .then(client => client.request(request))
      .catch(error => console.warn(`[backup] the ${label} signal was not delivered`, error));
  } catch (error) {
    console.warn(`[backup] the ${label} signal failed`, error);
  }
}

let forwarder: Promise<IIntercomClient> | null = null;

/** A lazy intercom client of this realm, loaded only where no handler is installed. */
function getForwarder(): Promise<IIntercomClient> {
  if (forwarder === null) {
    forwarder = import('lib/intercom/client').then(module => module.createIntercomClient());
  }
  return forwarder;
}

/**
 * The Guardian sync replaced this device's copy of an account with a newer
 * state, which in normal use means another device made a transaction. Asks for
 * a history read. Never throws, never waits, and does nothing when the backup
 * is off.
 */
export function signalGuardianStateAdopted(): void {
  signal('guardian-adopt', 'Guardian adoption');
}

/**
 * A transaction row of this device reached Completed. Asks for a history flush
 * at once, with no quiet period. Never throws, never waits, and does nothing
 * when the backup is off.
 */
export function signalTransactionCompleted(): void {
  signal('transaction-completed', 'transaction completion');
}
