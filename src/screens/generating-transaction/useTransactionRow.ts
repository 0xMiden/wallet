import { useEffect, useState } from 'react';

import { liveQuery } from 'dexie';

import type { ITransaction } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';

export interface TransactionRowState {
  /** The tracked transaction row, or undefined while loading / if the id is unknown. */
  row?: ITransaction;
  /** True once the first liveQuery result (row or empty) has arrived. */
  loaded: boolean;
}

/**
 * Subscribes to a single transaction row by id via Dexie `liveQuery` (push,
 * not polling — same mechanism as `waitForTransactionCompletion`). Unlike the
 * old `getAllUncompletedTransactions` list, the row never disappears when the
 * tx completes: it just advances Queued → GeneratingTransaction → Completed |
 * Failed, so status alone tells the page everything it needs.
 */
export const useTransactionRow = (txId: string): TransactionRowState => {
  const [state, setState] = useState<TransactionRowState>({ row: undefined, loaded: false });

  useEffect(() => {
    setState({ row: undefined, loaded: false });

    const subscription = liveQuery(() => Repo.transactions.where({ id: txId }).first()).subscribe({
      next: row => setState({ row: row ?? undefined, loaded: true }),
      error: () => setState({ row: undefined, loaded: true })
    });

    return () => subscription.unsubscribe();
  }, [txId]);

  return state;
};
