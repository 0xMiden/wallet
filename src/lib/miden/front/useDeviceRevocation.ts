import { useEffect, useState } from 'react';

import { liveQuery, Subscription } from 'dexie';

import { hasTransactionIndex } from 'lib/miden/db/index-query';
import { type ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { sameWalletAccountId } from 'lib/miden/sdk/helpers';
import { commitmentFromPublicKeyHex, sameCommitment } from 'lib/secure-hot-key/commitment';

/** Read the transaction link for a device already marked revoked. This receipt does not authorize a verdict. */
export function useDeviceRevocation(accountId: string | undefined, hotPublicKey: string | undefined) {
  const [receipt, setReceipt] = useState<{ accountId: string; hotPublicKey: string; transactionId: string }>();
  useEffect(() => {
    setReceipt(undefined);
    if (!accountId || !hotPublicKey) return;
    let cancelled = false;
    let subscription: Subscription | undefined;
    commitmentFromPublicKeyHex(hotPublicKey)
      .then(commitment => {
        if (cancelled) return;
        subscription = liveQuery(async () => {
          const matchesRevocation = (row: ITransaction) => {
            const target = row.extraInputs?.revokedSignerCommitment;
            return (
              row.type === 'replace-hot-key' &&
              row.status === ITransactionStatus.Completed &&
              sameWalletAccountId(row.accountId, accountId) &&
              typeof target === 'string' &&
              sameCommitment(target, commitment)
            );
          };
          const rows = hasTransactionIndex('[status+type]', Repo.transactions)
            ? await Repo.transactions
                .where('[status+type]')
                .equals([ITransactionStatus.Completed, 'replace-hot-key'])
                .filter(matchesRevocation)
                .toArray()
            : await Repo.transactions.filter(matchesRevocation).toArray();
          return rows.find(row => row.transactionId)?.transactionId;
        }).subscribe({
          next: transactionId => {
            if (!cancelled) setReceipt(transactionId ? { accountId, hotPublicKey, transactionId } : undefined);
          },
          error: error => console.warn('[device revocation] receipt read failed:', error)
        });
      })
      .catch(error => console.warn('[device revocation] receipt read failed:', error));
    return () => {
      cancelled = true;
      subscription?.unsubscribe();
    };
  }, [accountId, hotPublicKey]);
  if (receipt?.accountId !== accountId || receipt?.hotPublicKey !== hotPublicKey) return undefined;
  return receipt?.transactionId;
}
