import React, { FC, Suspense, useEffect, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';
import type { Address } from 'viem';

import { fetchRelayAccount } from 'lib/evm-relay/client';
import { assertRelayAccountMatches } from 'lib/evm-relay/guards';
import { type PendingRelayDeposit, usePendingRelayDeposits } from 'lib/evm-relay/pending-deposit';
import { depositArrivalOf } from 'lib/evm-relay/use-deposit-arrival';
import { isExtension, isMobile } from 'lib/platform';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';
import { getRelayChain } from 'lib/remote-config/values';
import { WalletStatus } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';
import { useLocation } from 'lib/woozie';

import { showDepositArrivalNotice } from './deposit-arrival-notice';
import { isDepositScreenPath, pendingDepositPath, servedPendingDeposits } from './pending-deposit-route';

/** The time between two reads of the watcher. */
export const DEPOSIT_ARRIVAL_WATCH_MS = 30_000;

/** The deposit ids that this realm announced: one notice for each id in a session. */
const announcedDepositIds = new Set<string>();

/** Tests only: forgets the announced ids. */
export function _resetAnnouncedDepositsForTest(): void {
  announcedDepositIds.clear();
}

interface ChainGroup {
  chainId: number;
  address: Address;
  deposits: PendingRelayDeposit[];
}

/** The deposits in groups of one relay address on one chain: one read for each group. */
function groupByChain(deposits: readonly PendingRelayDeposit[]): ChainGroup[] {
  const groups = new Map<string, ChainGroup>();
  for (const deposit of deposits) {
    const key = `${deposit.chainId}:${deposit.address}`;
    const group = groups.get(key);
    if (group) group.deposits.push(deposit);
    else groups.set(key, { chainId: deposit.chainId, address: deposit.address, deposits: [deposit] });
  }
  return [...groups.values()];
}

/**
 * Whether each deposit of the group arrived (the rule of `depositArrivalOf`). Null when the relay does not serve the
 * chain now. Throws when the read fails or the answer does not pass `assertRelayAccountMatches`.
 */
async function readArrivals(group: ChainGroup): Promise<Map<string, boolean> | null> {
  const chain = getRelayChain(group.chainId);
  if (chain === null) return null;
  const tokens = [...new Set(group.deposits.map(deposit => deposit.token.address))];
  const account = await fetchRelayAccount({ chainId: group.chainId, address: group.address, tokens });
  assertRelayAccountMatches(account, chain, group.address);
  const arrivals = new Map<string, boolean>();
  for (const deposit of group.deposits) {
    const balance =
      account.balances.find(entry => entry.token.toLowerCase() === deposit.token.address.toLowerCase())?.balance ??
      null;
    arrivals.set(deposit.id, depositArrivalOf(balance, BigInt(deposit.amountBaseUnits)).state === 'arrived');
  }
  return arrivals;
}

function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return visible;
}

/**
 * The arrival notice of a pending deposit ("We see your deposit. Tap to follow it.", mock-up `viewApp`). It follows
 * the pending deposits of the current account and announces a deposit once when a read sees it arrive after a read
 * that saw it not arrived. It reads every 30 seconds, only while the wallet is unlocked, a pending deposit exists on a
 * chain that the relay serves, the document is visible and the deposit screen is not open (that screen reads and
 * starts the bridge itself). It starts nothing. Mobile and the extension only: other platforms have no notice path.
 */
export const PendingDepositArrivalWatcher: FC = () => {
  if (!isMobile() && !isExtension()) return null;
  // The list read suspends once. The watcher draws nothing.
  return (
    <Suspense fallback={null}>
      <ArrivalWatch />
    </Suspense>
  );
};

const ArrivalWatch: FC = () => {
  const { t } = useTranslation();
  const accountPublicKey = useWalletStore(state =>
    state.status === WalletStatus.Ready ? state.currentAccount?.publicKey : undefined
  );
  const deposits = usePendingRelayDeposits(accountPublicKey);
  const snapshot = useBridgeConfigSnapshot({ load: false });
  const { pathname } = useLocation();
  const visible = useDocumentVisible();
  const onDepositScreen = isDepositScreenPath(pathname);

  const watched = servedPendingDeposits(deposits, snapshot);
  const watchKey = watched
    .map(
      deposit =>
        `${deposit.id}:${deposit.chainId}:${deposit.address}:${deposit.token.address}:${deposit.amountBaseUnits}`
    )
    .join('|');
  const watchedRef = useRef(watched);
  // The last read state of each deposit id: true when it arrived.
  const arrivedById = useRef(new Map<string, boolean>());

  useEffect(() => {
    watchedRef.current = watched;
  });

  useEffect(() => {
    // The deposit screen follows the deposit. A read after it closes starts from a new state, so a deposit that
    // arrived while that screen was open is not announced.
    if (onDepositScreen) arrivedById.current.clear();
  }, [onDepositScreen]);

  const active = accountPublicKey !== undefined && !onDepositScreen && visible && watchKey !== '';

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    let reading = false;
    const tick = async () => {
      if (reading) return;
      reading = true;
      try {
        for (const group of groupByChain(watchedRef.current)) {
          let arrivals: Map<string, boolean> | null;
          try {
            arrivals = await readArrivals(group);
          } catch (error) {
            console.warn('[deposit-flow] the arrival read failed', error);
            continue;
          }
          if (cancelled) return;
          if (arrivals === null) continue;
          for (const [id, arrived] of arrivals) {
            const before = arrivedById.current.get(id);
            arrivedById.current.set(id, arrived);
            if (!arrived || before !== false || announcedDepositIds.has(id)) continue;
            announcedDepositIds.add(id);
            showDepositArrivalNotice({
              title: t('appName'),
              body: t('depositFlowArrivalNotice'),
              path: pendingDepositPath(id),
              tag: `deposit-arrived:${id}`
            });
          }
        }
      } finally {
        reading = false;
      }
    };
    tick();
    const timer = setInterval(tick, DEPOSIT_ARRIVAL_WATCH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [active, watchKey, t]);

  return null;
};
