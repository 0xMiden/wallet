import { useEffect, useState } from 'react';

import { subscribeToLiveQuery } from 'lib/dexie-live-query';
import type { ITransaction } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';

export interface TransactionRowState {
  /** The tracked transaction row, or undefined while loading / if the id is unknown. */
  row?: ITransaction;
  /** True once the first liveQuery result (row or empty) has arrived. */
  loaded: boolean;
  /** The latest read failed; a retained row is stale until the existing subscription retries successfully. */
  readFailed?: true;
}

/**
 * Subscribes to a single transaction row by id via Dexie `liveQuery` (push,
 * not polling - same mechanism as `waitForTransactionCompletion`). Unlike the
 * old `getAllUncompletedTransactions` list, the row never disappears when the
 * tx completes: it just advances Queued → GeneratingTransaction → Completed |
 * Failed, so status alone tells the page everything it needs.
 */
export const useTransactionRow = (txId: string, probeReceiptRead = false): TransactionRowState => {
  const [state, setState] = useState<TransactionRowState>({ row: undefined, loaded: false });

  useEffect(() => {
    const probe =
      process.env.MIDEN_E2E_TEST === 'true' &&
      process.env.MIDEN_NETWORK === 'localhost' &&
      probeReceiptRead &&
      Reflect.get(globalThis, '__TEST_EARN_COLD_RECEIPT__') === true;
    if (probe) console.info('[earn-cold-receipt] subscribed');
    setState({ row: undefined, loaded: false });

    return subscribeToLiveQuery(() => Repo.transactions.where({ id: txId }).first(), {
      next: row => {
        if (probe) console.info('[earn-cold-receipt] result');
        setState({ row: row ?? undefined, loaded: true });
      },
      error: error => {
        if (probe) console.info('[earn-cold-receipt] read-error');
        setState(current => ({ ...current, readFailed: true }));
        console.error('[useTransactionRow] Failed to read transaction:', error);
      }
    });
  }, [txId, probeReceiptRead]);

  return state;
};
