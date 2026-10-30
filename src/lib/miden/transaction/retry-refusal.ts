import { guardianHoldRetryMessage } from './constants';

/**
 * Retry met a candidate the Guardian still holds (#1081). It carries when the hold clears, so a surface can state that
 * in the wallet's own terms; `message` stays the English sentence for logs.
 */
export class GuardianHoldRetryError extends Error {
  readonly clearsAtSec: number;

  constructor(clearsAtSec: number) {
    super(guardianHoldRetryMessage(clearsAtSec));
    this.name = 'GuardianHoldRetryError';
    this.clearsAtSec = clearsAtSec;
  }
}

/** Matched by `name`, like `isUnverifiableSendRetryError`: the retry can be driven from a bundle sharing no class. */
export const isGuardianHoldRetryError = (error: unknown): error is GuardianHoldRetryError =>
  error instanceof Error && error.name === 'GuardianHoldRetryError';

/** The text every surface shows for a refused Retry (#2060). */
export const retryRefusalText = (error: unknown, t: (key: string) => string): string =>
  error instanceof Error ? error.message : t('smthWentWrong');
