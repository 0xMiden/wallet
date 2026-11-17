import type { TFunction } from 'i18next';

import { LockedDepositError } from 'lib/epoch/bridge-in-recovery';
import type { UserErrorId } from 'lib/telemetry/user-visible-error-contract';
import { nativeSigningErrorId, nativeSigningErrorMessage } from 'lib/walletconnect/signing-error';

/** The id that reports a failure of the EVM wallet picker on the recovery screens. */
export const EVM_WALLET_PICKER_ERROR_ID: UserErrorId = 'raw_bridge_connect_failed';

/** A failed recovery as the screen shows it: the sentence, and the id that reports that the sentence was shown. */
export interface LockedDepositErrorDisplay {
  text: string;
  id: UserErrorId;
}

/**
 * The sentence and the report id for a failed recovery of a locked Epoch deposit. A known wallet signing failure keeps
 * its own id. Every other failure is a failed bridge deposit recovery.
 */
export function lockedDepositErrorDisplay(
  cause: unknown,
  t: TFunction,
  names: { network: string; address: string }
): LockedDepositErrorDisplay {
  return {
    text: lockedDepositErrorText(cause, t, names),
    id: nativeSigningErrorId(cause) ?? 'raw_bridge_deposit_failed'
  };
}

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
    case 'balanceUnreadable':
      return t('recoverFundsCouldNotCheckShort');
    case 'lockMismatch':
      return t('epochDepositErrorLockMismatch');
    case 'notRecoverable':
    default:
      return t('epochDepositErrorNotRecoverable');
  }
}
