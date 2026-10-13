import { useEffect, useState } from 'react';

import { IBridgedSendExtraInputs, ITransaction, ITransactionStatus } from 'lib/miden/db/types';

import { findUsdcxDestinationTransaction } from './destination-transaction';

/** Search only while a confirmed withdrawal's details are open. */
export function useUsdcxDestinationTransaction(tx: ITransaction | undefined): string | undefined {
  const extra: IBridgedSendExtraInputs | undefined = tx?.type === 'bridged-send' ? tx.extraInputs : undefined;
  const burn = extra?.provider === 'usdcx' ? extra.usdcxBurn : undefined;
  const beforeBlock = burn?.destinationBalanceBefore?.blockNumber;
  const confirmedBlock = burn?.destinationBalanceConfirmed?.blockNumber;
  const chainId = extra?.destinationNetwork;
  const recipient = extra?.destinationAddress;
  const amount = tx?.amount;
  const enabled = tx?.status === ITransactionStatus.Completed && !tx.restoredFromBackup && burn?.phase === 'confirmed';
  const key = [tx?.id, burn?.noteId, chainId, recipient, amount, beforeBlock, confirmedBlock].join(':');
  const [result, setResult] = useState<{ key: string; hash: string }>();

  useEffect(() => {
    if (!enabled || !beforeBlock || !confirmedBlock || !chainId || !recipient || !amount) return;
    let disposed = false;
    findUsdcxDestinationTransaction({ chainId, recipient, amount, beforeBlock, confirmedBlock }).then(
      hash => {
        if (!disposed && hash) setResult({ key, hash });
      },
      error => console.warn('[usdcx] Destination transaction search failed', error)
    );
    return () => {
      disposed = true;
    };
  }, [amount, beforeBlock, chainId, confirmedBlock, key, recipient, enabled]);

  return enabled && result?.key === key ? result.hash : undefined;
}
