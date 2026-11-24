import { getCurrentLocale } from 'lib/i18n/core';
import { formatHoldDeadline } from 'lib/i18n/hold-deadline';

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
  error instanceof Error &&
  error.name === 'GuardianHoldRetryError' &&
  'clearsAtSec' in error &&
  typeof error.clearsAtSec === 'number';

/** The text every surface shows for a refused Retry (#2060). */
export const retryRefusalText = (
  error: unknown,
  t: (key: string, substitutions?: Record<string, string>) => string
): string => {
  if (isGuardianHoldRetryError(error)) {
    const time = formatHoldDeadline(error.clearsAtSec, { locale: getCurrentLocale() });
    return t('guardianHoldRetryRefused', { time });
  }
  return error instanceof Error ? error.message : t('smthWentWrong');
};
