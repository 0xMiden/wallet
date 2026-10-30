import type { ITransactionIcon, ITransactionType } from 'lib/miden/db/types';
import { rotationRowTitleKey } from 'lib/miden/guardian/rotation-verdict';

import type { IHistoryEntry } from './IHistoryEntry';

export function guardianHistoryIcon(type: ITransactionType): ITransactionIcon {
  switch (type) {
    case 'send':
    case 'bridged-send':
      return 'SEND';
    case 'consume':
      return 'RECEIVE';
    case 'swap':
      return 'SWAP';
    default:
      return 'DEFAULT';
  }
}

export function guardianHistoryActionKey(type: ITransactionType, reclaimed = false, hotKeyAdded = false): string {
  switch (type) {
    case 'send':
      return 'sent';
    case 'consume':
      return reclaimed ? 'reclaimed' : 'received';
    case 'swap':
      return 'guardianHistorySwap';
    case 'bridged-send':
      return 'guardianHistoryBridgeOut';
    case 'earn-deposit':
      return 'guardianHistoryEarnDeposit';
    case 'switch-guardian':
      return 'guardianHistoryGuardianChanged';
    case 'replace-hot-key':
      return hotKeyAdded ? 'guardianHistoryDeviceAdded' : 'guardianHistoryDeviceReplaced';
    case 'update-procedure-threshold':
      return 'guardianHistoryAccountSecured';
    default:
      return 'guardianHistoryExecuted';
  }
}

/** Render-time labels: recovery stores evidence, not a fabricated transaction narrative. */
export function historyEntryActionTitle(entry: IHistoryEntry, t: (key: string) => string): string {
  if (entry.message === 'Transaction failed') {
    return t('transactionFailedNotificationTitle');
  }
  if (entry.revokedSignerCommitment) return t('deviceRevoked');
  if (entry.guardianRecovered) {
    return t(guardianHistoryActionKey(entry.txType, entry.guardianReclaimed, entry.hotKeyAdded));
  }
  if (entry.txType === 'switch-guardian' && entry.guardianSwitchVerdict) {
    const key = rotationRowTitleKey(entry.guardianSwitchVerdict);
    if (key) return t(key);
  }
  return entry.message?.trim() || t(guardianHistoryActionKey(entry.txType, entry.guardianReclaimed, entry.hotKeyAdded));
}
