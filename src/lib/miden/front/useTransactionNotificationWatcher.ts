import { useEffect } from 'react';

import { getCompletedTransactions } from 'lib/miden/activity';
import { IBridgeProvider, ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import { getTokenMetadata } from 'lib/miden/metadata/utils';
import { useWalletStore } from 'lib/store';
import { TransactionNotificationCandidate, transactionNotificationId } from 'lib/store/notifications';
import { useRetryableSWR } from 'lib/swr';

interface BridgedSendExtras {
  provider?: IBridgeProvider;
  destinationAddress?: string;
}

function readBridgedSendExtras(tx: ITransaction): BridgedSendExtras {
  if (tx.type !== 'bridged-send') return {};
  const extras: unknown = tx.extraInputs;
  if (typeof extras !== 'object' || extras === null) return {};

  const provider =
    'provider' in extras && (extras.provider === 'epoch' || extras.provider === 'agglayer')
      ? extras.provider
      : undefined;
  const destinationAddress =
    'destinationAddress' in extras && typeof extras.destinationAddress === 'string'
      ? extras.destinationAddress
      : undefined;

  return { provider, destinationAddress };
}

async function fetchCandidates(publicAddress: string): Promise<TransactionNotificationCandidate[]> {
  const { notificationsHydrated, notificationsByAccount, notificationTxWatermarks } = useWalletStore.getState();
  if (!notificationsHydrated) return [];

  // First run for this account: the reconcile action initializes the
  // watermark; building candidates would be wasted work (none would notify).
  const watermark = notificationTxWatermarks[publicAddress];
  if (watermark === undefined) return [];

  const transactions = await getCompletedTransactions(publicAddress, undefined, undefined, true);

  const existingIds = new Set((notificationsByAccount[publicAddress] ?? []).map(n => n.id));
  const fresh = transactions.filter(
    (tx): tx is ITransaction & { completedAt: number } =>
      tx.completedAt !== undefined && tx.completedAt > watermark && !existingIds.has(transactionNotificationId(tx.id))
  );

  const candidates: TransactionNotificationCandidate[] = [];
  for (const tx of fresh) {
    const metadata = tx.faucetId ? await getTokenMetadata(tx.faucetId) : undefined;
    const { provider, destinationAddress } = readBridgedSendExtras(tx);

    candidates.push({
      completedAtSec: tx.completedAt,
      payload: {
        txId: tx.id,
        txType: tx.type,
        status: tx.status === ITransactionStatus.Failed ? 'failed' : 'completed',
        amount: tx.amount !== undefined ? tx.amount.toString() : undefined,
        faucetId: tx.faucetId,
        symbol: metadata?.symbol,
        decimals: metadata?.decimals,
        displayMessage: tx.displayMessage,
        error: tx.error,
        noteId: tx.noteId,
        provider,
        destinationAddress
      }
    });
  }

  return candidates;
}

/**
 * Watches terminal-status transactions (Completed AND Failed — failed txs
 * are not shown in activity history, so their notification is the only
 * surface) and feeds them into the notification store. A persisted
 * per-account watermark prevents backfilling history on first run.
 *
 * Pure Dexie reads on the same cadence History.tsx already polls — no WASM
 * client involvement, safe on all platforms.
 */
export function useTransactionNotificationWatcher(publicAddress: string, enabled: boolean = true) {
  const hydrated = useWalletStore(s => s.notificationsHydrated);
  const reconcileTransactionNotifications = useWalletStore(s => s.reconcileTransactionNotifications);

  const key = enabled && hydrated ? ['tx-notification-watch', publicAddress] : null;
  const { data } = useRetryableSWR(key, () => fetchCandidates(publicAddress), {
    revalidateOnFocus: false,
    refreshInterval: 5_000,
    dedupingInterval: 3_000
  });

  useEffect(() => {
    if (!enabled || !hydrated || !data) return;
    // Called even with zero candidates — the action initializes the
    // first-run watermark.
    reconcileTransactionNotifications(publicAddress, data);
  }, [enabled, hydrated, data, publicAddress, reconcileTransactionNotifications]);
}
