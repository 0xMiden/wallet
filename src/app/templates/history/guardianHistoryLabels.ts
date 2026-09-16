import type { ITransactionIcon, ITransactionType } from 'lib/miden/db/types';

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

export function guardianHistoryActionKey(type: ITransactionType, reclaimed = false): string {
  switch (type) {
    case 'send': return 'sent';
    case 'consume': return reclaimed ? 'reclaimed' : 'received';
    case 'swap': return 'guardianHistorySwap';
    case 'bridged-send': return 'guardianHistoryBridgeOut';
    case 'earn-deposit': return 'guardianHistoryEarnDeposit';
    case 'switch-guardian': return 'guardianHistoryGuardianChanged';
    case 'replace-hot-key': return 'guardianHistoryDeviceReplaced';
    case 'update-procedure-threshold': return 'guardianHistoryAccountSecured';
    default: return 'guardianHistoryExecuted';
  }
}
