import { useEffect } from 'react';

import { liveQuery } from 'dexie';

import { midenClientProxy } from 'lib/miden/back/miden-client-proxy';
import { isBalanceReflected } from 'lib/miden/balance-snapshot';
import { ITransactionStatus } from 'lib/miden/db/types';
import { useMidenContext } from 'lib/miden/front/client';
import { fetchFromStorage, inStorageTurn, onStorageChanged, putToStorage } from 'lib/miden/front/storage';
import { isSyncFused, noteProbeFailure, noteSyncSuccess } from 'lib/miden/front/sync-fuse';
import * as Repo from 'lib/miden/repo';
import { assertWasmHoldCurrent, withWasmClientLock, type WasmLockHold } from 'lib/miden/sdk/miden-client';
import { WASM_LOCK_SYNC_WATCHDOG_MS } from 'lib/miden/sdk/wasm-client-poison';
import { isSwapPair } from 'lib/miden/swap/tokens';
import { getActiveOverride, getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { onStorageCleared } from 'lib/storage-cleared';
import { useWalletStore } from 'lib/store';

import { createBadgeIssuer } from './issuance';
import { BADGE_STORAGE_KEY, readEarnedBadges } from './types';

// A timer-driven hold (#777): bounded, labelled, and booked against the issuer's fuse key.
function verdictHold<T>(label: string, operation: (hold: WasmLockHold) => Promise<T>): Promise<T> {
  return withWasmClientLock(operation, { watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS, label }).catch((error: unknown) => {
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
      isMainnet: () => getEffectiveNetworkName() === 'mainnet' && getActiveOverride() === null,
      // A lit idle-sync fuse means the realm's client is parked too, which a verdict hold would rebuild against.
      canVerify: () => !isSyncFused('badge-verdict') && !isSyncFused('idle-sync'),
      readTransactions: () =>
        Repo.transactions
          .where('badgeNetwork')
          .equals('mainnet')
          .filter(row => row.status === ITransactionStatus.Completed)
          .toArray(),
      isCommitted: id =>
        verdictHold(
          'badge-commit-verdict',
          async () => (await midenClientProxy.getTransactionCommitState(id)) === 'committed'
        ),
      isBalanceReflected: requirement => isBalanceReflected(requirement, useWalletStore.getState().balances),
      isFilledApprovedSwap: swap =>
        verdictHold('badge-swap-verdict', async hold => {
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
      mergeAwards: (additions, current) =>
        inStorageTurn(BADGE_STORAGE_KEY, async () => {
          const stored = readEarnedBadges(await fetchFromStorage(BADGE_STORAGE_KEY));
          if (!current()) return;
          const merged = readEarnedBadges([...stored, ...additions]);
          if (merged.length !== stored.length) await putToStorage(BADGE_STORAGE_KEY, merged);
        }),
      reportError: error => console.warn('[badges] completion evidence unavailable; will retry', error)
    });
    const subscription = liveQuery(() =>
      Repo.transactions
        .where('badgeNetwork')
        .equals('mainnet')
        .filter(row => row.status === ITransactionStatus.Completed)
        .primaryKeys()
    ).subscribe({
      next: () => void issuer.refresh(),
      error: error => console.warn('[badges] history unavailable', error)
    });
    const stopReset = onStorageCleared(() => issuer.stop());
    const stopBalances = useWalletStore.subscribe((state, previous) => {
      if (state.balances !== previous.balances) void issuer.refresh();
    });
    // Extension resets happen in the service worker; its storage-removal event reaches this
    // document even before Ready changes. Watch presence only; never inspect/decrypt the value.
    const stopVaultRemoval = onStorageChanged<unknown>('vault_check', value => {
      if (value == null) issuer.stop();
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
      stopVaultRemoval();
      clearInterval(timer);
    };
  }, [accountKey]);
  return null;
}
