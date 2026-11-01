import { useEffect, useState } from 'react';

import { liveQuery } from 'dexie';

import { ITransactionStatus } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { sameWalletAccountId } from 'lib/miden/sdk/helpers';
import { withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { commitmentFromPublicKeyHex, sameCommitment } from 'lib/secure-hot-key/commitment';

/** Read the transaction link for a device already marked revoked. This receipt does not authorize a verdict. */
export function useDeviceRevocation(accountId: string | undefined, hotPublicKey: string | undefined) {
  const [receipt, setReceipt] = useState<{ accountId: string; hotPublicKey: string; transactionId: string }>();
  useEffect(() => {
    setReceipt(undefined);
    if (!accountId || !hotPublicKey) return;
    let cancelled = false;
    const subscription = liveQuery(async () => {
      const commitment = await withWasmClientLock(() => commitmentFromPublicKeyHex(hotPublicKey));
      const rows = await Repo.transactions
        .filter(row => {
          const target = row.extraInputs?.revokedSignerCommitment;
          return (
            row.type === 'replace-hot-key' &&
            row.status === ITransactionStatus.Completed &&
            sameWalletAccountId(row.accountId, accountId) &&
            typeof target === 'string' &&
            sameCommitment(target, commitment)
          );
        })
        .toArray();
      return rows.find(row => row.transactionId)?.transactionId;
    }).subscribe({
      next: transactionId => {
        if (!cancelled) setReceipt(transactionId ? { accountId, hotPublicKey, transactionId } : undefined);
      },
      error: error => console.warn('[device revocation] receipt read failed:', error)
    });
    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, [accountId, hotPublicKey]);
  if (receipt?.accountId !== accountId || receipt?.hotPublicKey !== hotPublicKey) return undefined;
  return receipt?.transactionId;
}
