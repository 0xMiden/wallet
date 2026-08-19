import React, { memo, RefObject, useMemo, useState } from 'react';

import { HISTORY_PAGE_SIZE } from 'app/defaults';
import {
  cancelTransactionById,
  getCompletedTransactions,
  getUncompletedTransactions,
  isUserCancelledTransaction,
  suppressingLinkedTxIds,
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
import { getTokenMetadata } from 'lib/miden/metadata/utils';
import { formatAmount } from 'lib/shared/format';
import { useRetryableSWR } from 'lib/swr';
import useSafeState from 'lib/ui/useSafeState';

import HistoryView from './HistoryView';
import { HistoryEntryType, IHistoryEntry } from './IHistoryEntry';
import {
  earnWithdrawAmountFields,
  isFaucetRequest as isFaucetEntry,
  resolveSwapHistoryFields
} from './transactionUtils';

type HistoryProps = {
  address: string;
  programId?: string | null;
  numItems?: number;
  scrollParentRef?: RefObject<HTMLDivElement>;
  className?: string;
  fullHistory?: boolean;
  centerEmptyState?: boolean;
  tokenId?: string;
  searchQuery?: string;
  filter?: 'all' | 'sent' | 'received' | 'faucet';
};

const History = memo<HistoryProps>(
  ({ address, className, numItems, scrollParentRef, fullHistory, centerEmptyState, tokenId, searchQuery, filter }) => {
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
    if (searchQuery?.trim()) {
      const query = searchQuery.toLowerCase();
      entries = entries.filter(
        e =>
          e.message?.toLowerCase().includes(query) ||
          e.token?.toLowerCase().includes(query) ||
          e.secondaryAddress?.toLowerCase().includes(query)
      );
    }
    if (filter && filter !== 'all') {
      // Failed/cancelled rows lose their directional icon (it becomes FAILED),
      // so the Sent/Received filters fall back to the underlying tx type.
      entries = entries.filter(e => {
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
    if (numItems) {
      const maxIndex = Math.min(numItems, entries.length);
      entries = entries.slice(0, maxIndex);
    }

    return (
      <HistoryView
        entries={entries ?? []}
        initialLoading={transactionsLoading}
        loadMore={loadMore}
        hasMore={hasMore}
        scrollParentRef={scrollParentRef}
        tokenId={tokenId}
        fullHistory={fullHistory}
        centerEmptyState={centerEmptyState}
        className={className}
      />
    );
  }
);

export default History;

/** Types whose (non-failed) row would carry the SEND icon. */
function isSendType(txType: IHistoryEntry['txType']): boolean {
  return txType === 'send' || txType === 'bridged-send';
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
    const entry = {
      address: address,
      key: `completed-${tx.id}`,
      timestamp: tx.completedAt,
      message: updateMessageForFailed,
      status: tx.status,
      type: HistoryEntryType.CompletedTransaction,
      transactionIcon: icon,
      amount: earnWithdrawFields
        ? earnWithdrawFields.amount
        : swapFields
          ? swapFields.amount
          : tx.amount
            ? formatAmount(tx.amount, tokenMetadata?.decimals)
            : undefined,
      token: earnWithdrawFields
        ? earnWithdrawFields.token
        : swapFields
          ? swapFields.token
          : tokenMetadata
            ? tokenMetadata.symbol
            : undefined,
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
      txId: tx.id,
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
      bridgeInProvider: bridgedReceive?.provider ?? bridgeIn?.provider,
      bridgeInSourceAddress: bridgedReceive?.sourceAddress,
      bridgeInSourceAmount: bridgedReceive?.sourceAmount ?? bridgeIn?.sourceAmount,
      bridgeInSourceSymbol: bridgedReceive?.sourceSymbol ?? bridgeIn?.sourceSymbol,
      bridgeInEvmTxHash: bridgedReceive?.evmTxHash ?? bridgeIn?.evmTxHash,
      bridgeInPhase: bridgedReceive?.phase,
      bridgeInOutputAmount: bridgedReceive?.outputAmount,
      bridgeInOutputSymbol: bridgedReceive?.outputSymbol,
      bridgeInMidenNoteId: bridgedReceive?.midenNoteId
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
    return {
      key: `pending-${tx.id}`,
      address: address,
      secondaryMessage: formatTransactionStatus(tx.status),
      timestamp: tx.initiatedAt,
      message: tx.displayMessage || 'Generating transaction',
      status: tx.status,
      amount: swapFields ? swapFields.amount : tx.amount ? formatAmount(tx.amount, tokenMetadata?.decimals) : undefined,
      token: swapFields ? swapFields.token : tokenMetadata ? tokenMetadata.symbol : undefined,
      requestedAmount: swapFields?.requestedAmount,
      requestedToken: swapFields?.requestedToken,
      requestedFaucetId: swapFields?.requestedFaucetId,
      // Bridge rows have no Miden recipient — surface the EVM destination instead.
      secondaryAddress: bridge?.destinationAddress ?? tx.secondaryAccountId,
      txId: tx.id,
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
      earnDepositStatus: earnDeposit?.epochStatus
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
 * the swap row on its requested-token page too.
 */
async function suppressLinkedConsumes<T extends ITransaction>(transactions: T[]): Promise<T[]> {
  const linkedTrackingIds = transactions.map(linkedPrimaryTxId).filter((id): id is string => Boolean(id));
  if (linkedTrackingIds.length === 0) return transactions;
  const suppressingIds = await suppressingLinkedTxIds(linkedTrackingIds);
  return transactions.filter(tx => {
    const linkedId = linkedPrimaryTxId(tx);
    return !(linkedId && suppressingIds.has(linkedId));
  });
}

/**
 * The primary row a `consume` transaction is the lifecycle tail of, if any —
 * swap-order settlement consumes (linked via `extraInputs.swapOrderTxId` by
 * `reconcileSwapOrderNotes`), Smart Withdraw delivery consumes (linked via
 * `extraInputs.bridgeIn.earnWithdrawTxId`) and bridged-receive delivery consumes
 * (linked via `extraInputs.bridgeIn.bridgeReceiveTxId`). While the primary row
 * exists AND is a valid trace it is the single trace; a dangling reference — or a
 * terminal-`failed` earn-withdraw primary (see `suppressingLinkedTxIds`) — falls
 * through to a normal receive row so the delivered funds stay visible.
 */
function linkedPrimaryTxId(tx: ITransaction): string | undefined {
  if (tx.type !== 'consume') return undefined;
  return (
    tx.extraInputs?.swapOrderTxId ??
    tx.extraInputs?.bridgeIn?.earnWithdrawTxId ??
    tx.extraInputs?.bridgeIn?.bridgeReceiveTxId
  );
}

/**
 * Settlement state for a completed swap order, driving the single swap row's
 * status chip; `undefined` renders Confirmed. Pending only for auto-consumed
 * orders that carry an explicit expiry (stamped since settlement shipped) and
 * have no settlement stamp yet — settled, legacy, and manual-claim orders all
 * fall through to Confirmed. A settledAt stamp wins over reclaimedAt (a batch
 * containing payback notes delivered funds even if the order later expired).
 */
function swapSettlementOf(tx: ITransaction): 'pending' | 'reclaimed' | undefined {
  if (tx.type !== 'swap' || tx.status !== ITransactionStatus.Completed) return undefined;
  const extra = tx.extraInputs ?? {};
  if (extra.settledAt != null) return undefined;
  if (extra.reclaimedAt != null) return 'reclaimed';
  if (extra.autoConsume !== false && extra.orderId != null && extra.expiresAt != null) return 'pending';
  return undefined;
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
