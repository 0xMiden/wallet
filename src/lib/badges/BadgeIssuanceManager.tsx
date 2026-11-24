import { useEffect } from 'react';

import { liveQuery } from 'dexie';

import { midenClientProxy } from 'lib/miden/back/miden-client-proxy';
import { isBalanceReflected } from 'lib/miden/balance-snapshot';
import { ITransactionStatus } from 'lib/miden/db/types';
import { useMidenContext } from 'lib/miden/front/client';
import { fetchFromStorage } from 'lib/miden/front/storage';
import { isSyncFused, noteProbeFailure, noteSyncSuccess } from 'lib/miden/front/sync-fuse';
import * as Repo from 'lib/miden/repo';
import { assertWasmHoldCurrent, withWasmClientLock, type WasmLockHold } from 'lib/miden/sdk/miden-client';
import { WASM_LOCK_SYNC_WATCHDOG_MS } from 'lib/miden/sdk/wasm-client-poison';
import { isSwapPair } from 'lib/miden/swap/tokens';
import {
  getActiveOverride,
  getEffectiveNetworkName,
  hasCustomEndpointOverride
} from 'lib/miden-chain/effective-endpoints';
import { onStorageCleared } from 'lib/storage-cleared';
import { useWalletStore } from 'lib/store';

import { evidenceTypes, ISSUABLE_BADGES } from './evidence';
import { createBadgeIssuer } from './issuance';
import { mergeBadgeAwards } from './progress';
import { BADGE_STORAGE_KEY, type BadgeId } from './types';

// The one read of badge evidence: an index range, so neither a wake-up nor a pass materialises other rows.
const badgeEvidence = (badges: readonly BadgeId[]) =>
  Repo.transactions
    .where('[badgeNetwork+status+type]')
    .anyOf(evidenceTypes(badges).map(type => ['mainnet', ITransactionStatus.Completed, type]));

// A timer-driven hold (#777): bounded, labelled, and booked against the issuer's fuse key. A fuse can light
// or the issuer stop while it queues, so once it holds the lock it asks again and declines (null) without a call.
function verdictHold<T>(
  label: string,
  checkable: () => boolean,
  operation: (hold: WasmLockHold) => Promise<T>
): Promise<T | null> {
  return withWasmClientLock<T | null>(async hold => (checkable() ? operation(hold) : null), {
    watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS,
    label
  }).catch((error: unknown) => {
    noteProbeFailure('badge-verdict', error);
    throw error;
  });
}

export function BadgeIssuanceManager(): null {
  const { accounts } = useMidenContext();
  const accountKey = accounts
    .map(account => account.publicKey)
    .sort()
    .join('\n');

  useEffect(() => {
    const accountIds = accountKey ? accountKey.split('\n') : [];
    const issuer = createBadgeIssuer({
      accounts: () => accountIds,
      // Developer endpoint overrides must not turn a private chain into Mainnet badge evidence.
      isMainnet: () => getEffectiveNetworkName() === 'mainnet' && !hasCustomEndpointOverride(getActiveOverride()),
      // A lit idle-sync fuse means the realm's client is parked too, which a verdict hold would rebuild against.
      canVerify: () => !isSyncFused('badge-verdict') && !isSyncFused('idle-sync'),
      readTransactions: badges => badgeEvidence(badges).toArray(),
      isCommitted: (id, checkable) =>
        verdictHold(
          'badge-commit-verdict',
          checkable,
          async () => (await midenClientProxy.getTransactionCommitState(id)) === 'committed'
        ),
      isBalanceReflected: requirement => isBalanceReflected(requirement, useWalletStore.getState().balances),
      isFilledApprovedSwap: (swap, checkable) =>
        verdictHold('badge-swap-verdict', checkable, async hold => {
          if (!isSwapPair(swap.offeredFaucetId, swap.requestedFaucetId)) return false;
          const lineages = await midenClientProxy.getPswapLineages(() =>
            assertWasmHoldCurrent(hold, 'badge swap lineage')
          );
          assertWasmHoldCurrent(hold, 'badge swap lineage');
          return lineages.some(
            lineage =>
              lineage.orderId === swap.orderId &&
              lineage.state === 1 &&
              BigInt(lineage.remainingOffered) === 0n &&
              BigInt(lineage.remainingRequested) === 0n
          );
        }),
      reportVerified: () => noteSyncSuccess('badge-verdict'),
      readAwards: () => fetchFromStorage(BADGE_STORAGE_KEY),
      mergeAwards: mergeBadgeAwards,
      reportError: error => console.warn('[badges] completion evidence unavailable; will retry', error)
    });
    const subscription = liveQuery(() => badgeEvidence(ISSUABLE_BADGES).primaryKeys()).subscribe({
      next: () => void issuer.refresh(),
      error: error => console.warn('[badges] history unavailable', error)
    });
    const stopReset = onStorageCleared(() => issuer.stop());
    const stopBalances = useWalletStore.subscribe((state, previous) => {
      if (state.balances !== previous.balances && issuer.awaitsBalance()) void issuer.refresh();
    });
    const timer = setInterval(() => {
      if (!document.hidden) void issuer.refresh();
    }, 15_000);
    void issuer.refresh();
    return () => {
      issuer.stop();
      subscription.unsubscribe();
      stopReset();
      stopBalances();
      clearInterval(timer);
    };
  }, [accountKey]);
  return null;
}
