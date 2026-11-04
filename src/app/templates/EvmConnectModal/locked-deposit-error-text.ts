import type { TFunction } from 'i18next';

import { LockedDepositError } from 'lib/epoch/bridge-in-recovery';
import { nativeSigningErrorMessage } from 'lib/walletconnect/signing-error';

/**
 * The sentence for a failed recovery of a locked Epoch deposit. A refusal has its own sentence, any other failure shows
 * its message. `network` names the chain of the lock and `address` its sponsor, shortened.
 */
export function lockedDepositErrorText(
  cause: unknown,
  t: TFunction,
  { network, address }: { network: string; address: string }
): string {
  if (!(cause instanceof LockedDepositError)) return nativeSigningErrorMessage(cause, t);
  switch (cause.reason) {
    case 'walletDisconnected':
      return t('epochDepositConnectSponsor', { address });
    case 'wrongAccount':
      return t('epochDepositWrongWallet', { address });
    case 'wrongChain':
      return t('epochDepositErrorWrongChain', { network });
    case 'withdrawalNotStarted':
      return t('epochDepositErrorNotStarted');
    case 'withdrawalNotDue':
      return t('epochDepositErrorNotDue');
    case 'depositMissing':
      return t('epochDepositErrorMissing');
    case 'lockMismatch':
      return t('epochDepositErrorLockMismatch');
    case 'notRecoverable':
    default:
      return t('epochDepositErrorNotRecoverable');
  }
}
