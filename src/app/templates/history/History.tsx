import React, { memo, RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { HISTORY_PAGE_SIZE } from 'app/defaults';
import { usePageActive } from 'app/layouts/page-active';
import {
  cancelTransactionById,
  getCompletedTransactions,
  getUncompletedTransactions,
  isCancellableTransaction,
  isUserCancelledTransaction,
  suppressedLinkedConsumeIds,
  USER_CANCELLED_TRANSACTION_REASON
} from 'lib/miden/activity';
import {
  formatTransactionStatus,
  IBridgedReceiveExtraInputs,
  IBridgedSendExtraInputs,
  IBridgeInInfo,
  IEarnDepositExtraInputs,
  IEarnWithdrawExtraInputs,
  ITransaction,
  ITransactionStatus,
  ISwitchGuardianExtraInputs
} from 'lib/miden/db/types';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { getTokenMetadata } from 'lib/miden/metadata/utils';
import { formatMidenName } from 'lib/miden/name/encoding';
import { formatAmount } from 'lib/shared/format';
import { useRetryableSWR } from 'lib/swr';
import useSafeState from 'lib/ui/useSafeState';

import HistoryView from './HistoryView';
import {
  HistoryEntryType,
  IHistoryEntry,
  midenNameActivityOf,
  midenNameLabelOf,
  reconcileMidenNameActivity
} from './IHistoryEntry';
import type { PendingActivityItem } from './PendingActivityCard';
import {
  earnWithdrawAmountFields,
  isFaucetRequest as isFaucetEntry,
  resolveConsumeExtraAmounts,
  resolveSwapHistoryFields,
  swapSettlementOf
} from './transactionUtils';

type HistoryProps = {
  address: string;
  programId?: string | null;
  numItems?: number;
  scrollParentRef?: RefObject<HTMLDivElement>;
  className?: string;
  fullHistory?: boolean;
  centerEmptyState?: boolean;
  /** The claims a card stands for; the consume row each would repeat is hidden. */
  pendingItems?: PendingActivityItem[];
  /** The cards drawn in the timeline, when fewer than `pendingItems` (a search); defaults to `pendingItems`. */
  drawnPendingItems?: PendingActivityItem[];
  renderPendingItem?: (item: PendingActivityItem) => React.ReactNode;
  tokenId?: string;
  searchQuery?: string;
  filter?: ActivityFilter;
  /**
   * Fired when the transaction query settles, i.e. when the list stops being a
   * spinner. The hosting screen reports "the user can see their activity" from
   * this; the loading state lives here, so nothing above can derive it.
   */
  onInitialLoad?: () => void;
  /**
   * Narrows the list further, after the search and the filter. The Groups view's own page hands
   * one group's matcher down here, so that page IS this list - paging, the in-flight rows and the
   * row rendering all come with it - rather than a second list that would drift from it.
   */
  predicate?: (entry: IHistoryEntry) => boolean;
  /**
   * Renders something other than the date-grouped timeline over the SAME loaded entries, with the
   * paging this component owns. The Groups view uses it; everything else gets `HistoryView`.
   */
  renderEntries?: (view: HistoryEntriesView) => React.ReactNode;
};

/** What `renderEntries` is handed: the loaded entries plus the paging state that produced them. */
export interface HistoryEntriesView {
  entries: IHistoryEntry[];
  initialLoading: boolean;
  /** Either read behind `entries` failed. */
  loadError: boolean;
  /** Re-runs both reads. */
  onRetry: () => void;
  /** False once the history is exhausted — which is when a count over `entries` is final. */
  hasMore: boolean;
  loadMore: (page: number) => Promise<void>;
}

/** Whether an activity row answers a search; `query` is already lowercased. */
export function historyEntryMatchesSearch(entry: IHistoryEntry, query: string): boolean {
  return Boolean(
    entry.message?.toLowerCase().includes(query) ||
    entry.token?.toLowerCase().includes(query) ||
    // A swap row shows the asset it asks for as well as the one it gives.
    entry.requestedToken?.toLowerCase().includes(query) ||
    // A batch claim displays its secondary assets on the row, so searching
    // for one has to find it, or typing a symbol the user can see hides
    // the very row showing it.
    entry.extraAmounts?.some(extra => extra.token.toLowerCase().includes(query)) ||
    entry.secondaryAddress?.toLowerCase().includes(query) ||
    // The row title shows the full name ("alice.miden"), so search for it too.
    (entry.midenNameLabel !== undefined && formatMidenName(entry.midenNameLabel).includes(query))
  );
}

// The chips above the activity list. `pending` shows only the notes that
// wait for a claim, so it removes every settled history row.
export type ActivityFilter = 'all' | 'pending' | 'sent' | 'received' | 'faucet';

type ScopedEntries = { key: string; entries: IHistoryEntry[] };

const NO_SCOPED_ENTRIES: ScopedEntries = { key: '', entries: [] };

const History = memo<HistoryProps>(
  ({
    address,
    className,
    numItems,
    scrollParentRef,
    fullHistory,
    centerEmptyState,
    tokenId,
    searchQuery,
    filter,
    onInitialLoad,
    predicate,
    renderEntries,
    pendingItems,
    drawnPendingItems,
    renderPendingItem
  }) => {
    const safeStateKey = useMemo(() => ['history', address, tokenId].join('_'), [address, tokenId]);
    const [isLoading, setIsLoading] = useState(false);
    const [hasMore, setHasMore] = useState(true);
    // Older pages carry the scope they were loaded for: `useSafeState` resets them in a passive effect, after
    // the first render of a new scope has already committed with the old scope's rows.
    const [scopedRest, setScopedRest] = useSafeState<ScopedEntries>(NO_SCOPED_ENTRIES, safeStateKey);
    const restEntries = scopedRest.key === safeStateKey ? scopedRest.entries : NO_SCOPED_ENTRIES.entries;

    // `restEntries` is keyed to the scope; these two are not, so without this
    // they outlive it. A failed page sets `hasMore` false to stop the retry spin
    // — correct for the scope that failed, but the flag would then follow the
    // user to every other account and token page in this mount and silently
    // disable their pagination too.
    //
    // The ref is the same problem seen from the other end: `useSafeState`'s
    // setter only checks that the component is still MOUNTED, not that the key
    // still matches, so a page already in flight when the user switches account
    // would land its rows in the new account's list.
    //
    // `useLayoutEffect`, not `useEffect`: a passive effect is flushed by the
    // scheduler AFTER paint, while a resolving fetch is a microtask. In that
    // window the ref would still hold the old key and the stale page would sail
    // through the guard. A layout effect runs inside commit, closing it. (Tests
    // cannot see the difference — `act` flushes passive effects synchronously.)
    //
    // A monotonic counter rather than the key itself: comparing keys says "the
    // scope matches now", which an A → B → A round trip satisfies while the
    // original A request is still in flight. That request would then settle
    // `hasMore` and `isLoading` for the second visit's own paging.
    const scopeRef = useRef(0);
    useLayoutEffect(() => {
      scopeRef.current += 1;
      setHasMore(true);
      setIsLoading(false);
    }, [safeStateKey]);

    const onScreen = usePageActive();
    // The Pending filter shows transfer cards only, and a retained page off screen shows nothing, so the
    // transaction reads run only while neither holds.
    const reading = onScreen && filter !== 'pending';

    // No `keepPreviousData`: both keys carry the address and token, so it would show another
    // account's (or token's) rows while this one loads; a key's own refresh keeps its data anyway.
    const {
      data: latestTransactions,
      isLoading: transactionsLoading,
      error: latestError,
      mutate: mutateLatest
    } = useRetryableSWR(
      [`latest-transactions`, address, tokenId],
      async () => fetchTransactionsAsHistoryEntries(address, undefined, undefined, tokenId),
      {
        revalidateOnMount: true,
        refreshInterval: 10_000,
        dedupingInterval: 3_000,
        isPaused: () => !reading
      }
    );

    const {
      data: latestPendingTransactions,
      isLoading: pendingLoading,
      error: pendingError,
      mutate: mutateTx
    } = useRetryableSWR(
      [`latest-pending-transactions`, address, tokenId],
      async () => fetchPendingTransactionsAsHistoryEntries(address, tokenId),
      {
        revalidateOnMount: true,
        refreshInterval: 5_000,
        dedupingInterval: 3_000,
        isPaused: () => !reading
      }
    );
    useEffect(() => {
      if (transactionsLoading) return;
      onInitialLoad?.();
    }, [transactionsLoading, onInitialLoad]);

    // A paused read only ticks again on its next interval, so reads that resume refresh at once: a page back on
    // screen, or a filter moved off Pending.
    const wasReading = useRef(reading);
    useEffect(() => {
      if (reading && !wasReading.current) {
        void mutateLatest();
        void mutateTx();
      }
      wasReading.current = reading;
    }, [reading, mutateLatest, mutateTx]);

    const pendingTransactions = useMemo(
      () =>
        latestPendingTransactions?.map(tx => {
          // A structural op already in flight gets no Cancel — see
          // `isCancellableTransaction`. The pending list is Queued +
          // GeneratingTransaction, so this is the only place the distinction can
          // be made before the affordance is attached.
          if (!isCancellableTransaction({ status: tx.status, type: tx.txType })) return tx;
          tx.cancel = async () => {
            if (tx.txId) {
              await cancelTransactionById(tx.txId, USER_CANCELLED_TRANSACTION_REASON);
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
      const scope = scopeRef.current;
      const key = safeStateKey;
      const offset = HISTORY_PAGE_SIZE * page;
      const limit = HISTORY_PAGE_SIZE;
      try {
        const olderTransactions = await fetchTransactionsAsHistoryEntries(address, offset, limit, tokenId);
        // Answer for a scope the user has since left: its rows are another
        // account's history.
        if (scopeRef.current !== scope) return;
        // Key off what the PAGE returned, not the merged list. Merged, the list
        // is non-empty from the first successful page onward, so an exhausted
        // history never sets the flag: the scroller re-arms on each parent
        // render (SWR re-renders this on a timer) and fires an endless run of
        // empty queries. A short page is also the last one, so stop there rather
        // than spending one more round trip to see an empty one.
        if (olderTransactions.length < limit) {
          setHasMore(false);
        }
        // Merge against the stored rows, not this render's: a closure from the first render after a switch
        // still holds the old scope's.
        setScopedRest(prev => ({
          key,
          entries: mergeAndSort(prev.key === key ? prev.entries : [], olderTransactions)
        }));
      } catch (error) {
        // Stop paging on failure. Clearing `isLoading` without this would spin:
        // the infinite scroller re-arms on every parent render (and SWR re-renders
        // this on a timer), so a persistently failing page would be retried for
        // the rest of the session. Leaving `isLoading` set instead would wedge
        // pagination permanently, so neither flag alone is the answer — the list
        // keeps everything already loaded and simply stops extending.
        console.error(
          `Failed to load history page ${page} (offset ${offset}, limit ${limit}) for ${address}${
            tokenId ? ` token ${tokenId}` : ''
          }`,
          error
        );
        // Same reasoning as the success path: do not disable pagination for a
        // scope the user has already moved on to.
        if (scopeRef.current === scope) setHasMore(false);
      } finally {
        if (scopeRef.current === scope) setIsLoading(false);
      }
    };

    // A card stands in for the consume row only while there is still something to DO with it: a
    // claim in flight (the card holds the spinner) or one that failed (the card offers Retry).
    // An ACCEPTED transfer has no card any more — it is an ordinary row in this feed, drawn by
    // the same component as every other settled transaction — so its consume row must come
    // through rather than be hidden behind a card that no longer exists.
    const representedNotes = new Set(
      pendingItems?.filter(item => item.status === 'claiming' || item.status === 'failed').map(item => item.note.id)
    );
    let entries: IHistoryEntry[] = reconcileMidenNameActivity(allEntries).filter(
      entry =>
        !(
          entry.txType === 'consume' &&
          entry.consumedNoteIds?.length &&
          entry.consumedNoteIds.every(id => representedNotes.has(id))
        )
    );
    if (searchQuery?.trim()) {
      const query = searchQuery.toLowerCase();
      entries = entries.filter(e => historyEntryMatchesSearch(e, query));
    }
    if (filter && filter !== 'all') {
      // Failed/cancelled rows lose their directional icon (it becomes FAILED),
      // so the Sent/Received filters fall back to the underlying tx type.
      entries = entries.filter(e => {
        if (filter === 'pending') return false;
        if (filter === 'sent') {
          return e.transactionIcon === 'SEND' || (e.transactionIcon === 'FAILED' && isSendType(e.txType));
        }
        if (filter === 'received') {
          return (
            (e.transactionIcon === 'RECEIVE' || (e.transactionIcon === 'FAILED' && e.txType === 'consume')) &&
            !isFaucetEntry(e)
          );
        }
        if (filter === 'faucet') return isFaucetEntry(e);
        return true;
      });
    }
    // Last, so a group's page narrows what the search and the filter already left.
    if (predicate) {
      entries = entries.filter(predicate);
    }
    if (numItems) {
      const maxIndex = Math.min(numItems, entries.length);
      entries = entries.slice(0, maxIndex);
    }

    // Under Pending both reads are paused, and one that never ran reports loading until they resume.
    // One list, so it is loading until both reads have answered once.
    const initialLoading = filter !== 'pending' && (transactionsLoading || pendingLoading);
    // The list is both reads together, so either failing is a failed load, and Retry re-runs both.
    const loadError = filter !== 'pending' && Boolean(latestError || pendingError);
    const onRetry = () => {
      void mutateLatest();
      void mutateTx();
    };

    if (renderEntries) {
      return (
        <>
          {renderEntries({
            entries,
            initialLoading,
            loadError,
            onRetry,
            hasMore: reading && hasMore,
            loadMore
          })}
        </>
      );
    }

    return (
      <HistoryView
        entries={entries ?? []}
        initialLoading={initialLoading}
        loadError={loadError}
        onRetry={onRetry}
        loadMore={loadMore}
        // Paging reads transaction rows too, so it stops wherever the reads above pause: under Pending, where every
        // row is filtered out, and off screen.
        hasMore={reading && hasMore}
        scrollParentRef={scrollParentRef}
        tokenId={tokenId}
        fullHistory={fullHistory}
        centerEmptyState={centerEmptyState}
        pendingItems={drawnPendingItems ?? pendingItems}
        renderPendingItem={renderPendingItem}
        className={className}
      />
    );
  }
);

export default History;

/** Types whose (non-failed) row would carry the SEND icon. */
function isSendType(txType: IHistoryEntry['txType']): boolean {
  return (
    txType === 'send' || txType === 'bridged-send' || txType === 'register-name' || txType === 'publish-name-record'
  );
}

async function fetchTransactionsAsHistoryEntries(
  address: string,
  offset?: number,
  limit?: number,
  tokenId?: string
): Promise<IHistoryEntry[]> {
  const transactions = await getCompletedTransactions(address, offset, limit, true, tokenId);
  const visibleTransactions = await suppressLinkedConsumes(transactions);
  const entries = visibleTransactions.map(async tx => {
    const isCancelled = isUserCancelledTransaction(tx.error);
    const updateMessageForFailed = isCancelled
      ? 'Cancelled'
      : tx.status === ITransactionStatus.Failed
        ? 'Transaction failed'
        : tx.displayMessage;
    const icon = tx.status === ITransactionStatus.Failed ? 'FAILED' : tx.displayIcon;
    const tokenMetadata = tx.faucetId ? await getTokenMetadata(tx.faucetId) : undefined;
    const bridge = tx.type === 'bridged-send' ? (tx.extraInputs as IBridgedSendExtraInputs | undefined) : undefined;
    const bridgeIn: IBridgeInInfo | undefined = tx.type === 'consume' ? tx.extraInputs?.bridgeIn : undefined;
    const bridgedReceive =
      tx.type === 'bridged-receive' ? (tx.extraInputs as IBridgedReceiveExtraInputs | undefined) : undefined;
    const earnWithdraw: IEarnWithdrawExtraInputs | undefined = tx.type === 'earn-withdraw' ? tx.extraInputs : undefined;
    const earnDeposit: IEarnDepositExtraInputs | undefined = tx.type === 'earn-deposit' ? tx.extraInputs : undefined;
    const guardianSwitch: ISwitchGuardianExtraInputs | undefined =
      tx.type === 'switch-guardian' ? tx.extraInputs : undefined;
    // Source side (USDC) while in flight, destination side once the bridged note
    // was consumed — see `earnWithdrawAmountFields`.
    const earnWithdrawFields = earnWithdraw
      ? earnWithdrawAmountFields(earnWithdraw, tx.amount, tokenMetadata)
      : undefined;
    // Swap faucets are usually absent from wallet metadata — resolve both
    // sides through the DEX registry instead of the generic path.
    const swapFields = tx.type === 'swap' ? await resolveSwapHistoryFields(tx) : undefined;
    const extraAmounts = await resolveConsumeExtraAmounts(tx);
    const entry = {
      address: address,
      key: `completed-${tx.id}`,
      // Same fallback the query sorts by (`getCompletedTransactions`) and the
      // detail view renders. A terminal row is not guaranteed to carry
      // `completedAt`, and the day grouping builds a Date from this with no
      // fallback of its own — one missing value takes down the whole list.
      timestamp: tx.completedAt ?? tx.initiatedAt,
      message: updateMessageForFailed,
      status: tx.status,
      type: HistoryEntryType.CompletedTransaction,
      transactionIcon: icon,
      amount: earnWithdrawFields
        ? earnWithdrawFields.amount
        : swapFields
          ? swapFields.amount
          : // `!== undefined`, not truthiness: `0n` is a real total. A claim whose
            // primary faucet sums to zero would otherwise render no amount at all,
            // and take every secondary asset down with it (see `buildRowProps`).
            //
            // `hasKnownScale` withholds the number when the faucet resolved only
            // to the unknown-token placeholder, whose 6 decimals are a guess: the
            // asset is still NAMED below, so the row keeps its headline slot
            // rather than promoting a secondary over it.
            tx.amount !== undefined && hasKnownScale(tokenMetadata)
            ? formatAmount(tx.amount, tokenMetadata?.decimals)
            : undefined,
      token: earnWithdrawFields
        ? earnWithdrawFields.token
        : swapFields
          ? swapFields.token
          : tokenMetadata
            ? tokenMetadata.symbol
            : undefined,
      extraAmounts: extraAmounts.length > 0 ? extraAmounts : undefined,
      earnWithdrawPhase: earnWithdraw?.phase,
      // The Miden collateral note landing is only half a deposit — the chip
      // tracks the Sepolia lending leg.
      earnDepositStatus: earnDeposit?.epochStatus,
      requestedAmount: swapFields?.requestedAmount,
      requestedToken: swapFields?.requestedToken,
      requestedFaucetId: swapFields?.requestedFaucetId,
      swapSettlement: swapSettlementOf(tx),
      // Bridge rows have no Miden recipient — surface the EVM destination instead.
      secondaryAddress: bridge?.destinationAddress ?? tx.secondaryAccountId,
      recipientName: tx.recipientName,
      ...midenNameActivityOf(tx),
      txId: tx.id,
      consumedNoteIds: tx.type === 'consume' ? (tx.noteIds ?? (tx.noteId ? [tx.noteId] : [])) : undefined,
      noteType: tx.noteType,
      faucetId: tx.faucetId,
      txType: tx.type,
      previousGuardianEndpoint: guardianSwitch?.previousGuardianEndpoint,
      newGuardianEndpoint: guardianSwitch?.newGuardianEndpoint,
      errorMessage: tx.error,
      isCancelled,
      bridgeProvider: bridge?.provider,
      bridgeDestinationAddress: bridge?.destinationAddress,
      bridgeDestinationNetwork: bridge?.destinationNetwork,
      bridgeClaimStatus: bridge?.claimStatus,
      bridgeOutputAmount: bridge?.outputAmount,
      bridgeOutputSymbol: bridge?.outputSymbol,
      bridgeIntentNonce: bridge?.intentNonce,
      bridgeFillTxHash: bridge?.fillTxHash,
      bridgeFillChainId: bridge?.fillChainId,
      bridgeEpochStatus: bridge?.epochStatus,
      bridgeReclaimHeight: bridge?.reclaimHeight,
      restoredFromBackup: tx.restoredFromBackup,
      bridgeInProvider: bridgedReceive?.provider ?? bridgeIn?.provider,
      bridgeInSourceAddress: bridgedReceive?.sourceAddress ?? bridgeIn?.intentOwner,
      bridgeInSourceAmount: bridgedReceive?.sourceAmount ?? bridgeIn?.sourceAmount,
      bridgeInSourceSymbol: bridgedReceive?.sourceSymbol ?? bridgeIn?.sourceSymbol,
      bridgeInEvmTxHash: bridgedReceive?.evmTxHash ?? bridgeIn?.evmTxHash,
      bridgeInPhase: bridgedReceive?.phase,
      bridgeInOutputAmount: bridgedReceive?.outputAmount,
      bridgeInOutputSymbol: bridgedReceive?.outputSymbol,
      bridgeInMidenNoteId: bridgedReceive?.midenNoteId ?? bridgeIn?.midenNoteId,
      midenNameLabel: midenNameLabelOf(tx)
    } as IHistoryEntry;

    return entry;
  });

  return await Promise.all(entries);
}

async function fetchPendingTransactionsAsHistoryEntries(address: string, tokenId?: string): Promise<IHistoryEntry[]> {
  const pendingTransactions = await suppressLinkedConsumes(await getUncompletedTransactions(address, tokenId));

  const entryPromises = pendingTransactions.map(async tx => {
    const entryType =
      tx.status !== ITransactionStatus.Queued
        ? HistoryEntryType.ProcessingTransaction
        : HistoryEntryType.PendingTransaction;
    const tokenMetadata = tx.faucetId ? await getTokenMetadata(tx.faucetId) : undefined;
    const bridge = tx.type === 'bridged-send' ? (tx.extraInputs as IBridgedSendExtraInputs | undefined) : undefined;
    const earnDeposit: IEarnDepositExtraInputs | undefined = tx.type === 'earn-deposit' ? tx.extraInputs : undefined;
    const guardianSwitch: ISwitchGuardianExtraInputs | undefined =
      tx.type === 'switch-guardian' ? tx.extraInputs : undefined;
    const swapFields = tx.type === 'swap' ? await resolveSwapHistoryFields(tx) : undefined;
    const extraAmounts = await resolveConsumeExtraAmounts(tx);
    return {
      key: `pending-${tx.id}`,
      address: address,
      secondaryMessage: formatTransactionStatus(tx.status),
      timestamp: tx.initiatedAt,
      message: tx.displayMessage || 'Generating transaction',
      status: tx.status,
      amount: swapFields
        ? swapFields.amount
        : // See the completed-history fetcher above: `0n` is a real total, and a
          // faucet that resolved only to the unknown-token placeholder has no
          // trustworthy scale to convert by.
          tx.amount !== undefined && hasKnownScale(tokenMetadata)
          ? formatAmount(tx.amount, tokenMetadata?.decimals)
          : undefined,
      token: swapFields ? swapFields.token : tokenMetadata ? tokenMetadata.symbol : undefined,
      extraAmounts: extraAmounts.length > 0 ? extraAmounts : undefined,
      requestedAmount: swapFields?.requestedAmount,
      requestedToken: swapFields?.requestedToken,
      requestedFaucetId: swapFields?.requestedFaucetId,
      // Bridge rows have no Miden recipient — surface the EVM destination instead.
      secondaryAddress: bridge?.destinationAddress ?? tx.secondaryAccountId,
      recipientName: tx.recipientName,
      ...midenNameActivityOf(tx),
      txId: tx.id,
      consumedNoteIds: tx.type === 'consume' ? (tx.noteIds ?? (tx.noteId ? [tx.noteId] : [])) : undefined,
      type: entryType,
      noteType: tx.noteType,
      faucetId: tx.faucetId,
      txType: tx.type,
      previousGuardianEndpoint: guardianSwitch?.previousGuardianEndpoint,
      newGuardianEndpoint: guardianSwitch?.newGuardianEndpoint,
      bridgeProvider: bridge?.provider,
      bridgeDestinationAddress: bridge?.destinationAddress,
      bridgeDestinationNetwork: bridge?.destinationNetwork,
      bridgeClaimStatus: bridge?.claimStatus,
      bridgeOutputAmount: bridge?.outputAmount,
      bridgeOutputSymbol: bridge?.outputSymbol,
      bridgeIntentNonce: bridge?.intentNonce,
      bridgeFillTxHash: bridge?.fillTxHash,
      bridgeFillChainId: bridge?.fillChainId,
      bridgeEpochStatus: bridge?.epochStatus,
      bridgeReclaimHeight: bridge?.reclaimHeight,
      restoredFromBackup: tx.restoredFromBackup,
      earnDepositStatus: earnDeposit?.epochStatus,
      midenNameLabel: midenNameLabelOf(tx)
    } as IHistoryEntry;
  });
  const entries = await Promise.all(entryPromises);
  return entries;
}

/**
 * Suppress auto-consume rows that are the tail of another row's lifecycle
 * while that primary row still exists — it is the single trace: a swap
 * order's settlement consume (payback claim or expiry reclaim, linked via
 * `swapOrderTxId`). A dangling reference (primary row gone) falls through
 * to a normal receive row. Shared by the completed and pending fetches so the
 * two lists can't desynchronize. Token-scoped views stay complete because the
 * token filter (`matchesTokenId` in `lib/miden/transaction/get.ts`) surfaces
 * the swap row on its requested-token page too. The tab's unread mark
 * (`useHasUnreadActivity`) reads through it as well, so it never counts a row
 * this feed hides.
 */
export async function suppressLinkedConsumes<T extends ITransaction>(transactions: T[]): Promise<T[]> {
  const suppressed = await suppressedLinkedConsumeIds(transactions);
  return transactions.filter(tx => !suppressed.has(tx.id));
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
