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

/** True while the store says Locked; a closed lock prompt reads it to tell "still locked" from a decline. */
export function isStoreLocked(): boolean {
  return store.getState().status === WalletStatus.Locked;
}

/**
 * Resolves true once the store is unlocked (at once if it already is), or false after `timeoutMs` or once `closed`
 * aborts.
 */
export function waitForUnlock(timeoutMs: number, closed?: AbortSignal): Promise<boolean> {
  // Ahead of the status: a closed popup must not build, even if the wallet has been unlocked since.
  if (closed?.aborted) return Promise.resolve(false);
  if (store.getState().status === WalletStatus.Ready) return Promise.resolve(true);
  return new Promise(resolve => {
    const finish = (isUnlocked: boolean) => {
      clearTimeout(timer);
      unwatch();
      closed?.removeEventListener('abort', onClose);
      resolve(isUnlocked);
    };
    const onClose = () => finish(false);
    const unwatch = store.updates.watch(state => {
      if (state.status === WalletStatus.Ready) finish(true);
    });
    const timer = setTimeout(() => finish(false), timeoutMs);
    closed?.addEventListener('abort', onClose);
  });
}

/**
 * `build`, run once for every caller. A build that meets a locked wallet waits for the next unlock (up to `timeoutMs`,
 * then refuses as locked) and runs again; only a successful result is kept, so every caller gets data from a build
 * that ran unlocked. Once `closed` aborts, a build waiting for the unlock refuses as locked instead of running again.
 */
export function onceAfterUnlock<T>(build: () => Promise<T>, timeoutMs: number, closed?: AbortSignal): () => Promise<T> {
  let kept: Promise<T> | undefined;
  const run = async (): Promise<T> => {
    for (;;) {
      try {
        return await build();
      } catch (error) {
        if (!isWalletLockedError(error)) throw error;
      }
      if (!(await waitForUnlock(timeoutMs, closed))) throw lockedRefusal();
    }
  };
  return () => {
    if (kept === undefined) {
      const attempt = run();
      kept = attempt;
      attempt.catch(() => {
        if (kept === attempt) kept = undefined;
      });
    }
    return kept;
  };
}
