import React, { memo, RefObject, useMemo, useState } from 'react';

import { HISTORY_PAGE_SIZE } from 'app/defaults';
import { cancelTransactionById, getCompletedTransactions, getUncompletedTransactions } from 'lib/miden/activity';
import { formatTransactionStatus, ITransactionStatus } from 'lib/miden/db/types';
import { getTokenMetadata } from 'lib/miden/metadata/utils';
import { formatAmount } from 'lib/shared/format';
import { useRetryableSWR } from 'lib/swr';
import useSafeState from 'lib/ui/useSafeState';

import HistoryView from './HistoryView';
import { HistoryEntryType, IHistoryEntry } from './IHistoryEntry';

type HistoryProps = {
  address: string;
  programId?: string | null;
  numItems?: number;
  scrollParentRef?: RefObject<HTMLDivElement>;
  className?: string;
  fullHistory?: boolean;
  tokenId?: string;
};

const History = memo<HistoryProps>(({ address, className, numItems, scrollParentRef, fullHistory, tokenId }) => {
  const safeStateKey = useMemo(() => ['history', address, tokenId].join('_'), [address, tokenId]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [restEntries, setRestEntries] = useSafeState<Array<IHistoryEntry>>([], safeStateKey);

  const { data: latestTransactions, isLoading: transactionsLoading } = useRetryableSWR(
    [`latest-transactions`, address, tokenId],
    async () => fetchTransactionsAsHistoryEntries(address, undefined, undefined, tokenId),
    {
      revalidateOnMount: true,
      refreshInterval: 10_000,
      dedupingInterval: 3_000,
      keepPreviousData: true
    }
  );

  const { data: latestPendingTransactions, mutate: mutateTx } = useRetryableSWR(
    [`latest-pending-transactions`, address, tokenId],
    async () => fetchPendingTransactionsAsHistoryEntries(address, tokenId),
    {
      revalidateOnMount: true,
      refreshInterval: 5_000,
      dedupingInterval: 3_000,
      keepPreviousData: true
    }
  );
  const pendingTransactions = useMemo(
    () =>
      latestPendingTransactions?.map(tx => {
        tx.cancel = async () => {
          if (tx.txId) {
            await cancelTransactionById(tx.txId, 'Transaction was cancelled by user');
            mutateTx();
          }
        };
        return tx;
      }) || [],
    [latestPendingTransactions, mutateTx]
  );

  // Don't sort the pending transactions, earliest should come first as they are processed first
  const allEntries = useMemo(
    () => pendingTransactions.concat(mergeAndSort(latestTransactions ?? [], restEntries)),
    [latestTransactions, restEntries, pendingTransactions]
  );

  const loadMore = async (page: number) => {
    // already loading, don't make duplicate calls
    if (isLoading) {
      return;
    }
    setIsLoading(true);
    const offset = HISTORY_PAGE_SIZE * page;
    const limit = HISTORY_PAGE_SIZE;
    const olderTransactions = await fetchTransactionsAsHistoryEntries(address, offset, limit, tokenId);
    const allRestEntries = mergeAndSort(restEntries, olderTransactions);

    if (allRestEntries.length === 0) {
      setHasMore(false);
    }
    setRestEntries(allRestEntries);
    setIsLoading(false);
  };

  let entries: IHistoryEntry[] = allEntries;
  if (numItems) {
    const maxIndex = Math.min(numItems, allEntries.length);
    entries = entries.slice(0, maxIndex);
  }

  return (
    <HistoryView
      entries={entries ?? []}
      initialLoading={transactionsLoading}
      loadMore={loadMore}
      hasMore={hasMore}
      scrollParentRef={scrollParentRef}
      fullHistory={fullHistory}
      className={className}
    />
  );
});

export default History;

async function fetchTransactionsAsHistoryEntries(
  address: string,
  offset?: number,
  limit?: number,
  tokenId?: string
): Promise<IHistoryEntry[]> {
  const transactions = await getCompletedTransactions(address, offset, limit, false, tokenId);
  const entries = transactions.map(async tx => {
    const updateMessageForFailed = tx.status === ITransactionStatus.Failed ? 'Transaction failed' : tx.displayMessage;
    const icon = tx.status === ITransactionStatus.Failed ? 'FAILED' : tx.displayIcon;
    const tokenMetadata = tx.faucetId ? await getTokenMetadata(tx.faucetId) : undefined;
    const entry = {
      address: address,
      key: `completed-${tx.id}`,
      timestamp: tx.completedAt,
      message: updateMessageForFailed,
      type: HistoryEntryType.CompletedTransaction,
      transactionIcon: icon,
      amount: tx.amount ? formatAmount(tx.amount, tx.type, tokenMetadata?.decimals) : undefined,
      token: tokenMetadata ? tokenMetadata.symbol : undefined,
      secondaryAddress: tx.secondaryAccountId,
      txId: tx.id,
      noteType: tx.noteType,
      faucetId: tx.faucetId
    } as IHistoryEntry;

    return entry;
  });

  return await Promise.all(entries);
}

async function fetchPendingTransactionsAsHistoryEntries(address: string, tokenId?: string): Promise<IHistoryEntry[]> {
  let pendingTransactions = await getUncompletedTransactions(address, tokenId);

  const entryPromises = pendingTransactions.map(async tx => {
    const entryType =
      tx.status !== ITransactionStatus.Queued
        ? HistoryEntryType.ProcessingTransaction
        : HistoryEntryType.PendingTransaction;
    const tokenMetadata = tx.faucetId ? await getTokenMetadata(tx.faucetId) : undefined;
    return {
      key: `pending-${tx.id}`,
      address: address,
      secondaryMessage: formatTransactionStatus(tx.status),
      timestamp: tx.initiatedAt,
      message: tx.displayMessage || 'Generating transaction',
      amount: tx.amount ? formatAmount(tx.amount, tx.type, tokenMetadata?.decimals) : undefined,
      token: tokenMetadata ? tokenMetadata.symbol : undefined,
      secondaryAddress: tx.secondaryAccountId,
      txId: tx.id,
      type: entryType,
      noteType: tx.noteType,
      faucetId: tx.faucetId
    } as IHistoryEntry;
  });
  const entries = await Promise.all(entryPromises);
  return entries;
}

function mergeAndSort(base?: IHistoryEntry[], toAppend: IHistoryEntry[] = []) {
  if (!base) return [];

  const uniqueKeys = new Set<string>();
  const uniques: IHistoryEntry[] = [];
  for (const entry of [...base, ...toAppend]) {
    if (!uniqueKeys.has(entry.key)) {
      uniqueKeys.add(entry.key);
      uniques.push(entry);
    }
  }
  uniques.sort((r1, r2) => r2.timestamp - r1.timestamp || r2.type - r1.type);
  return uniques;
}
