import { MidenDAppErrorType } from 'lib/adapter/types';
import { WalletStatus } from 'lib/shared/types';

import { store } from './store';
import { isPipelineKillLink } from '../sdk/sdk-error-code';

/** What a dApp is answered when its request met a locked wallet and the user did not unlock. */
export const WALLET_LOCKED_REFUSAL = `${MidenDAppErrorType.NotGranted}: Wallet is locked`;

export function lockedRefusal(): Error {
  return new Error(WALLET_LOCKED_REFUSAL);
}

/**
 * True when `error` is the store gate's refusal of a locked wallet (`assertUnlocked` tags it `reason: 'locked'`), the
 * one failure a dApp request answers with an Unlock step. Classified from the error, so a lock that lands mid-request
 * counts the same as one that was there first.
 */
export function isWalletLockedError(error: unknown): boolean {
  // A kill is never a lock, whatever it carries (issue #775): the abandoned pipeline may still run.
  if (isPipelineKillLink(error)) return false;
  if (typeof error !== 'object' || error === null || Reflect.get(error, 'reason') !== 'locked') return false;
  // An Idle store (no vault) fails the same gate with the same tag, but there is nothing to unlock.
  return store.getState().status !== WalletStatus.Idle;
}
