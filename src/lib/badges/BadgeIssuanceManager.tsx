import { useEffect } from 'react';

import { liveQuery } from 'dexie';

import { midenClientProxy } from 'lib/miden/back/miden-client-proxy';
import { ITransactionStatus } from 'lib/miden/db/types';
import { useMidenContext } from 'lib/miden/front/client';
import { fetchFromStorage, inStorageTurn, onStorageChanged, putToStorage } from 'lib/miden/front/storage';
import * as Repo from 'lib/miden/repo';
import { assertWasmHoldCurrent, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { WASM_LOCK_SYNC_WATCHDOG_MS } from 'lib/miden/sdk/wasm-client-poison';
import { isSwapPair } from 'lib/miden/swap/tokens';
import { getActiveOverride, getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { onStorageCleared } from 'lib/storage-cleared';

import { createBadgeIssuer } from './issuance';
import { BADGE_STORAGE_KEY, readEarnedBadges } from './types';

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
      readTransactions: () =>
        Repo.transactions
          .where('badgeNetwork')
          .equals('mainnet')
          .filter(row => row.status === ITransactionStatus.Completed)
          .toArray(),
      isCommitted: id =>
        withWasmClientLock(async () => (await midenClientProxy.getTransactionCommitState(id)) === 'committed', {
          watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS,
          label: 'badge-commit-verdict'
        }),
      isFilledApprovedSwap: swap =>
        withWasmClientLock(
          async hold => {
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
          },
          { watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS, label: 'badge-swap-verdict' }
        ),
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
      stopVaultRemoval();
      clearInterval(timer);
    };
  }, [accountKey]);
  return null;
}
