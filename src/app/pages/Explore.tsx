import React, { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import useVerificationBaseFee from 'app/hooks/useVerificationBaseFee';
import Balance from 'app/templates/Balance';
import HomePrompts from 'app/templates/HomePrompts';
import { AssetRow } from 'components/AssetRow';
import { ConnectivityIssueBanner } from 'components/ConnectivityIssueBanner';
import { Loader } from 'components/Loader';
import { AccountsDrawer, BalanceCard, SearchInput } from 'components/ui';
import { toLocalFormat } from 'lib/i18n/numbers';
import {
  initiateConsumeTransaction,
  reconcileBridgedReceives,
  requestSWTransactionProcessing,
  startBackgroundTransactionProcessing
} from 'lib/miden/activity';
import { isWorthClaiming } from 'lib/miden/fees/spendable';
import { useAccount, useAllBalances, useAllTokensBaseMetadata, useMidenContext } from 'lib/miden/front';
import type { TokenBalanceData } from 'lib/miden/front';
import { useClaimableNotes } from 'lib/miden/front/claimable-notes';
import { zustandProvider } from 'lib/miden/front/guardian-sync';
import { clearNoteReceivedNotification } from 'lib/mobile/native-notifications';
import { isExtension, isMobile } from 'lib/platform';
import { getTokenPrice } from 'lib/prices';
import type { TokenPrices } from 'lib/prices';
import { isAutoConsumeEnabled, isDelegateProofEnabled } from 'lib/settings/helpers';
import { WalletAccount } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';
import type { PendingNoteValue } from 'lib/wallet-prompts';
import { navigate } from 'lib/woozie';
import { isHexAddress } from 'utils/miden';
import { truncateAddress } from 'utils/string';

const PULL_TO_REFRESH_THRESHOLD = 72;
/** Decorative aria-hidden pull-to-refresh arrow glyph (not translatable copy). */
const PULL_TO_REFRESH_ARROW = '↓';
const MAX_PULL_DISTANCE = 104;
const REFRESH_INDICATOR_DISTANCE = 56;

interface PullGesture {
  startX: number;
  startY: number;
  distance: number;
}

// Resume bridge-receive tracking and Smart Withdraw rows orphaned by an app
// kill exactly once per session (post-unlock, when Explore first mounts).
// Module-level so they survive remounts.
let bridgeReceivesReconciled = false;
let earnWithdrawReconciled = false;
let earnDepositsReconciled = false;

const Explore: FC = () => {
  const { t } = useTranslation();
  const isMobileApp = isMobile();
  const account = useAccount();
  const midenFaucetId = useMidenFaucetId();
  const verificationBaseFee = useVerificationBaseFee();
  const { signTransaction } = useMidenContext();
  const allTokensBaseMetadata = useAllTokensBaseMetadata();
  const {
    data: allTokenBalances = [],
    isLoading: balancesLoading,
    mutate: mutateBalances
  } = useAllBalances(account.publicKey, allTokensBaseMetadata);
  const tokenPrices = useWalletStore(s => s.tokenPrices);

  const { data: claimableNotes, mutate: mutateClaimableNotes } = useClaimableNotes(account.publicKey);
  const isDelegatedProvingEnabled = isDelegateProofEnabled();
  const shouldAutoConsume = isAutoConsumeEnabled();

  const address = account.publicKey;

  const [search, setSearch] = useState('');
  const [pullDistance, setPullDistance] = useState(0);
  const [isPulling, setIsPulling] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const pullGestureRef = useRef<PullGesture | null>(null);

  const midenNotes = useMemo(() => {
    if (!shouldAutoConsume || !claimableNotes) {
      return [];
    }

    // Swap-managed notes have their own lineage-aware settlement path. This
    // explicit guard also protects native-asset swap notes whose per-order
    // auto-consume setting is off: they remain available for manual settlement
    // without being picked up by the wallet-wide native-note auto-consumer.
    // A note worth no more than its own fee costs the user money to collect, and
    // this consumer runs without asking. `isWorthClaiming` fails open while the
    // fee is unknown, so discovery latency never strands a real note.
    return claimableNotes.filter(
      note => note!.faucetId === midenFaucetId && !note!.swapOrder && isWorthClaiming(note!.amount, verificationBaseFee)
    );
  }, [claimableNotes, midenFaucetId, shouldAutoConsume, verificationBaseFee]);

  const hasAutoConsumableNotes = useMemo(() => {
    return midenNotes.length > 0;
  }, [midenNotes]);

  const autoConsumeMidenNotes = useCallback(async () => {
    if (!shouldAutoConsume || !hasAutoConsumableNotes) {
      return;
    }

    const notesToClaim = midenNotes!.filter(note => !note.isBeingClaimed);
    if (notesToClaim.length === 0) {
      return;
    }

    const promises = notesToClaim.map(async note => {
      await initiateConsumeTransaction(account.publicKey, note, isDelegatedProvingEnabled);
    });
    await Promise.all(promises);
    // The wallet is now auto-claiming these notes, so the "click to claim"
    // notification is stale — dismiss it so it doesn't linger (#459).
    clearNoteReceivedNotification();
    mutateClaimableNotes();

    if (isExtension()) {
      requestSWTransactionProcessing();
    } else {
      startBackgroundTransactionProcessing(signTransaction, false, zustandProvider);
    }
  }, [
    midenNotes,
    isDelegatedProvingEnabled,
    mutateClaimableNotes,
    account.publicKey,
    shouldAutoConsume,
    hasAutoConsumableNotes,
    signTransaction
  ]);

  useEffect(() => {
    if (hasAutoConsumableNotes) {
      autoConsumeMidenNotes();
    }
  }, [autoConsumeMidenNotes, hasAutoConsumableNotes]);

  useEffect(() => {
    if (isHexAddress(address)) {
      navigate('/reset-required');
    }
  }, [address]);

  useEffect(() => {
    if (earnWithdrawReconciled) return;
    earnWithdrawReconciled = true;
    import('lib/epoch')
      .then(({ reconcileEarnWithdrawals }) => reconcileEarnWithdrawals())
      .catch(err => console.warn('[earn-withdraw] reconcile on mount failed', err));
  }, []);

  // Deposit-side counterpart: `pollEarnIntentStatus` is a popup-lifetime
  // setInterval, so rows can be stranded on `epochStatus: 'pending'` after the
  // process dies. Re-poll (or restart polling for) those once per session.
  useEffect(() => {
    if (earnDepositsReconciled) return;
    earnDepositsReconciled = true;
    import('lib/epoch')
      .then(({ reconcileEarnDeposits }) => reconcileEarnDeposits())
      .catch(err => console.warn('[earn] deposit reconcile on mount failed', err));
  }, []);

  useEffect(() => {
    if (bridgeReceivesReconciled) return;
    bridgeReceivesReconciled = true;
    reconcileBridgedReceives().catch(err => console.warn('[bridge-receive] reconcile on mount failed', err));
  }, []);

  const filteredTokens = useMemo(() => {
    const sorted = [...allTokenBalances].sort((a, b) => {
      const aIsNative = a.tokenId === midenFaucetId;
      const bIsNative = b.tokenId === midenFaucetId;
      if (aIsNative !== bIsNative) return aIsNative ? -1 : 1;

      const aFiatValue = a.balance * getTokenPrice(tokenPrices, a.metadata.symbol).price;
      const bFiatValue = b.balance * getTokenPrice(tokenPrices, b.metadata.symbol).price;
      return bFiatValue - aFiatValue;
    });
    if (!search.trim()) return sorted;
    const query = search.toLowerCase();
    return sorted.filter(
      asset => asset.metadata.symbol.toLowerCase().includes(query) || asset.metadata.name?.toLowerCase().includes(query)
    );
  }, [allTokenBalances, midenFaucetId, search, tokenPrices]);

  const refreshExplore = useCallback(async () => {
    if (isRefreshing) return;

    setIsRefreshing(true);
    setPullDistance(REFRESH_INDICATOR_DISTANCE);
    try {
      await Promise.all([mutateBalances(), mutateClaimableNotes()]);
    } catch (error) {
      console.error('Failed to refresh Explore:', error);
    } finally {
      setIsRefreshing(false);
      setPullDistance(0);
    }
  }, [isRefreshing, mutateBalances, mutateClaimableNotes]);

  const handleTouchStart = useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      const isDarkMode = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
      if (isDarkMode || isRefreshing || event.touches.length !== 1 || event.currentTarget.scrollTop > 0) return;

      const touch = event.touches[0]!;
      pullGestureRef.current = { startX: touch.clientX, startY: touch.clientY, distance: 0 };
    },
    [isRefreshing]
  );

  const handleTouchMove = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const gesture = pullGestureRef.current;
    if (!gesture || event.touches.length !== 1 || event.currentTarget.scrollTop > 0) return;

    const touch = event.touches[0]!;
    const deltaY = touch.clientY - gesture.startY;
    const deltaX = Math.abs(touch.clientX - gesture.startX);

    // Give horizontal gestures to HomeSwipeContainer and upward gestures to
    // the native scroller. We only take over once the intent is clearly down.
    if (deltaY <= 0 || deltaX > deltaY) {
      pullGestureRef.current = null;
      setIsPulling(false);
      setPullDistance(0);
      return;
    }

    event.preventDefault();
    const distance = Math.min(MAX_PULL_DISTANCE, deltaY * 0.5);
    gesture.distance = distance;
    setIsPulling(true);
    setPullDistance(distance);
  }, []);

  const finishPullGesture = useCallback(() => {
    const shouldRefresh = (pullGestureRef.current?.distance ?? 0) >= PULL_TO_REFRESH_THRESHOLD;
    pullGestureRef.current = null;
    setIsPulling(false);

    if (shouldRefresh) {
      void refreshExplore();
    } else {
      setPullDistance(0);
    }
  }, [refreshExplore]);

  if (isHexAddress(address)) {
    return null;
  }

  return (
    <div className="flex flex-col h-full overflow-hidden bg-app-bg font-inter" data-testid="explore-page">
      <div className="shrink-0">
        <ConnectivityIssueBanner />
      </div>

      <div
        className="relative flex-1 min-h-0 overflow-y-auto overscroll-contain"
        data-testid="explore-scroll-container"
        onTouchStart={isMobileApp ? handleTouchStart : undefined}
        onTouchMove={isMobileApp ? handleTouchMove : undefined}
        onTouchEnd={isMobileApp ? finishPullGesture : undefined}
        onTouchCancel={isMobileApp ? finishPullGesture : undefined}
      >
        {isMobileApp && (
          <div
            className="pointer-events-none absolute inset-x-0 top-0 flex h-14 items-center justify-center text-text-secondary-token"
            data-testid="pull-to-refresh-indicator"
            aria-live="polite"
          >
            {isRefreshing ? (
              <Loader size="sm" aria-label={t('loading')} />
            ) : (
              <span
                aria-hidden="true"
                className={`text-xl transition-transform ${pullDistance >= PULL_TO_REFRESH_THRESHOLD ? 'rotate-180' : ''}`}
              >
                {PULL_TO_REFRESH_ARROW}
              </span>
            )}
          </div>
        )}

        <div
          className={`relative flex flex-col gap-3 bg-app-bg px-4 pt-3 pb-32 ${isPulling ? '' : 'transition-transform duration-200 ease-out'}`}
          style={{ transform: `translateY(${pullDistance}px)` }}
        >
          <HomeOverview
            address={address}
            tokenPrices={tokenPrices}
            balances={allTokenBalances}
            filteredTokens={filteredTokens}
            search={search}
            onSearchChange={setSearch}
            account={account}
            balancesLoading={balancesLoading}
            claimableNotes={claimableNotes}
          />
        </div>
      </div>
    </div>
  );
};

export default Explore;

interface HomeOverviewProps {
  address: string;
  tokenPrices: TokenPrices;
  balances: TokenBalanceData[];
  filteredTokens: TokenBalanceData[];
  search: string;
  onSearchChange: (v: string) => void;
  account: WalletAccount;
  balancesLoading: boolean;
  claimableNotes: readonly PendingNoteValue[] | undefined;
}

const HomeOverview: FC<HomeOverviewProps> = ({
  address,
  tokenPrices,
  balances,
  filteredTokens,
  search,
  onSearchChange,
  account,
  balancesLoading,
  claimableNotes
}) => {
  const [accountsOpen, setAccountsOpen] = useState(false);
  const { t } = useTranslation();
  return (
    <>
      <Balance>
        {balance => (
          <BalanceCard
            accountNumber={truncateAddress(address, false, 8)}
            accountId={address}
            // Gap 16: until real prices have loaded, every token falls back to the
            // $1 default, so the "USD total" would be a fabricated number equal to
            // the raw token count. When no prices are available (feed down or still
            // loading) show "$—" rather than that fake figure; once any real price
            // lands (stale-but-real via keepPreviousData counts), show the total.
            // UX-REVIEW: a dash is the conservative honest choice; a UX owner may
            // prefer a skeleton or an explicit "prices unavailable" affordance.
            amount={Object.keys(tokenPrices).length === 0 ? '$—' : `$${toLocalFormat(balance, { decimalPlaces: 2 })}`}
            currency="USD"
            delta={{ absolute: '+0.00', percentage: '0.00%', direction: 'positive' }}
            onMore={() => setAccountsOpen(true)}
          />
        )}
      </Balance>

      <AccountsDrawer open={accountsOpen} onOpenChange={setAccountsOpen} />

      <HomePrompts
        account={account}
        balances={balances}
        balancesLoading={balancesLoading}
        claimableNotes={claimableNotes}
        tokenPrices={tokenPrices}
      />

      <div className="flex items-center justify-between pt-2">
        <span className="text-2xl font-bold text-text-primary-token">{t('assets')}</span>
      </div>

      <SearchInput value={search} onChange={onSearchChange} placeholder={t('searchForTokens')} />

      <div className="flex flex-col divide-y divide-rule-default">
        {filteredTokens.map(asset => (
          <AssetRow
            key={asset.tokenId}
            asset={asset}
            tokenPrices={tokenPrices}
            onClick={() => navigate(`/token-detail/${asset.tokenId}`)}
          />
        ))}
      </div>
    </>
  );
};
