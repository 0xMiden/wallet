import React, { FC, RefObject, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { useHiddenTokens } from 'app/hooks/useHiddenTokens';
import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import useVerificationBaseFee from 'app/hooks/useVerificationBaseFee';
import { Icon, IconName } from 'app/icons/v2';
import Balance from 'app/templates/Balance';
import HomePrompts from 'app/templates/HomePrompts';
import { AssetRow } from 'components/AssetRow';
import { ConnectivityIssueBanner } from 'components/ConnectivityIssueBanner';
import { Loader } from 'components/Loader';
import { NetworkModePill } from 'components/NetworkModePill';
import {
  AccountsDrawer,
  AnimatedNumber,
  AssetListItemSkeleton,
  BalanceCard,
  ErrorLine,
  TextAction
} from 'components/ui';
import { springs, useMotion, usePreset } from 'lib/animation';
import { toLocalFormat } from 'lib/i18n/numbers';
import {
  initiateConsumeNotesTransaction,
  initiateConsumeTransaction,
  requestSWTransactionProcessing,
  startBackgroundTransactionProcessing
} from 'lib/miden/activity';
import { useAccount, useAllBalances, useAllTokensBaseMetadata, useMidenContext } from 'lib/miden/front';
import type { TokenBalanceData } from 'lib/miden/front';
import { excludeAutoManagedNotes, selectAutoConsumeBatch } from 'lib/miden/front/auto-managed-notes';
import { useClaimableNotes } from 'lib/miden/front/claimable-notes';
import { zustandProvider } from 'lib/miden/front/guardian-sync';
import { formatMidenName } from 'lib/miden/name/encoding';
import { useOwnedMidenName } from 'lib/miden/name/registrations';
import { clearNoteReceivedNotification } from 'lib/mobile/native-notifications';
import { isExtension, isMobile } from 'lib/platform';
import { pricesLoaded } from 'lib/prices';
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

  const {
    data: claimableNotes,
    isFallback: claimableNotesAreCached,
    mutate: mutateClaimableNotes
  } = useClaimableNotes(account.publicKey);
  const isDelegatedProvingEnabled = isDelegateProofEnabled();
  const shouldAutoConsume = isAutoConsumeEnabled();

  const address = account.publicKey;

  const { isHidden, unhide } = useHiddenTokens(address);

  const [pullDistance, setPullDistance] = useState(0);
  const [isPulling, setIsPulling] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const pullGestureRef = useRef<PullGesture | null>(null);

  // A rotation-pending account's native notes are the rotation gate's to claim (#805).
  // Narrower than consumeServiceFor's check (flag AND no hotPublicKey) -- deliberate:
  // the only cost is one auto-claim delayed a sync lap, never a wrong consume.
  const rotationPending = account.requiresHotKeyRotation === true;
  const midenNotes = useMemo(() => {
    if (!shouldAutoConsume || !claimableNotes || rotationPending) {
      return [];
    }
    return selectAutoConsumeBatch(claimableNotes, midenFaucetId, verificationBaseFee);
  }, [claimableNotes, midenFaucetId, rotationPending, shouldAutoConsume, verificationBaseFee]);

  const hasAutoConsumableNotes = useMemo(() => {
    return midenNotes.length > 0;
  }, [midenNotes]);

  // What the "You have transfers to accept" card may ask the user to act on: the notes this
  // page, the SW and NativeNoteAutoConsumeManager will NOT claim for them. Feeding it
  // the raw list surfaced a card, with a USD total, for native notes that were already
  // being auto-consumed (#811).
  const manuallyClaimableNotes = useMemo(
    () => excludeAutoManagedNotes(claimableNotes, midenFaucetId, shouldAutoConsume, verificationBaseFee),
    [claimableNotes, midenFaucetId, shouldAutoConsume, verificationBaseFee]
  );

  const autoConsumeMidenNotes = useCallback(async () => {
    if (!shouldAutoConsume || !hasAutoConsumableNotes) {
      return;
    }

    // Already filtered for `isBeingClaimed` by `selectAutoConsumeBatch`, where the value
    // check needs the same set. Re-filtering here would let the two diverge again.
    const notesToClaim = midenNotes;
    if (notesToClaim.length === 0) {
      return;
    }

    // ONE transaction for the batch, matching the other two native auto-consumers
    // (`NativeNoteAutoConsumeManager`, the SW sync pass): every consume pays its own
    // fee, so a backlog claimed note-by-note charges N fees for what settles in one.
    // This consumer runs on Home and fires on render, so it usually WINS the race
    // against the others -- leaving it per-note meant the batching those two do was
    // defeated in the common case.
    //
    // Poison-note isolation is the LAST argument, not this catch: an un-consumable note
    // fails at generation time, long after this queue write returned, so the catch here
    // only ever sees a DB error. See `initiateConsumeNotesTransaction`.
    try {
      await initiateConsumeNotesTransaction(
        account.publicKey,
        notesToClaim,
        isDelegatedProvingEnabled,
        false,
        true,
        verificationBaseFee
      );
    } catch (batchErr) {
      console.warn('[native-auto-consume] batch enqueue failed, falling back to per-note enqueue', batchErr);
      for (const note of notesToClaim) {
        try {
          await initiateConsumeTransaction(account.publicKey, note, isDelegatedProvingEnabled);
        } catch (noteErr) {
          console.warn('[native-auto-consume] enqueue failed for note', note.id, noteErr);
        }
      }
    }
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
    signTransaction,
    verificationBaseFee
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

  const { sortedTokens, hiddenTokens } = useMemo(() => {
    // A token with no price, or whose balance was scaled by guessed decimals, ranks as worth
    // nothing, never as its token count at $1 a unit.
    const fiatValues = new Map(
      allTokenBalances.map(token => [
        token,
        hasKnownScale(token.metadata)
          ? token.balance * (tokenQuote(tokenPrices, token.tokenId, token.metadata.symbol)?.price ?? 0)
          : 0
      ])
    );
    const sorted = [...allTokenBalances].sort((a, b) => {
      const aIsNative = a.tokenId === midenFaucetId;
      const bIsNative = b.tokenId === midenFaucetId;
      if (aIsNative !== bIsNative) return aIsNative ? -1 : 1;
      return fiatValues.get(b)! - fiatValues.get(a)!;
    });
    // A hidden token moves to the Hidden assets section under the list; the hook never reports
    // the native token hidden.
    return {
      sortedTokens: sorted.filter(token => !isHidden(token.tokenId)),
      hiddenTokens: sorted.filter(token => isHidden(token.tokenId))
    };
  }, [allTokenBalances, isHidden, midenFaucetId, tokenPrices]);

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
          className={`relative flex flex-col gap-3 bg-app-bg px-4 pt-3 pb-24 ${isPulling ? '' : 'transition-transform duration-200 ease-out'}`}
          style={{ transform: `translateY(${pullDistance}px)` }}
        >
          <NetworkModePill />

          <HomeOverview
            address={address}
            tokenPrices={tokenPrices}
            balances={allTokenBalances}
            sortedTokens={sortedTokens}
            hiddenTokens={hiddenTokens}
            onUnhide={unhide}
            account={account}
            balancesLoading={balancesLoading}
            claimableNotes={manuallyClaimableNotes}
            // A faucet baseline has to be a LIVE list: the hook serves the list
            // saved last session first, and a native note newer than that cache
            // would otherwise count as this request's mint arriving.
            fundingNotes={claimableNotesAreCached ? undefined : claimableNotes}
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
  sortedTokens: TokenBalanceData[];
  hiddenTokens: TokenBalanceData[];
  onUnhide: (tokenId: string) => Promise<boolean>;
  account: WalletAccount;
  balancesLoading: boolean;
  claimableNotes: readonly PendingNoteValue[] | undefined;
  fundingNotes: readonly PendingNoteValue[] | undefined;
}

/**
 * The card's total: always two decimals, so a count never changes the number of them mid-flight.
 * No currency symbol: the card shows the currency as its own unit beside the amount.
 */
const usdTotal = (value: number) => toLocalFormat(value, { decimalPlaces: 2 });

const HomeOverview: FC<HomeOverviewProps> = ({
  address,
  tokenPrices,
  balances,
  sortedTokens,
  hiddenTokens,
  onUnhide,
  account,
  balancesLoading,
  claimableNotes,
  fundingNotes
}) => {
  const [accountsOpen, setAccountsOpen] = useState(false);
  const { t } = useTranslation();
  // Undefined on a network with no Miden Name deployment.
  const ownedMidenName = useOwnedMidenName(address);
  return (
    <>
      <Balance>
        {balance => (
          <BalanceCard
            accountNumber={truncateAddress(address, false, 8)}
            accountId={address}
            accountName={account.name}
            accountAlias={ownedMidenName ? formatMidenName(ownedMidenName) : undefined}
            // Gap 16: until real prices have loaded, every token falls back to the
            // $1 default, so the "USD total" would be a fabricated number equal to
            // the raw token count. When no prices are available (feed down or still
            // loading) show "$—" rather than that fake figure; once any real price
            // lands (stale-but-real via keepPreviousData counts), show the total.
            // UX-REVIEW: a dash is the conservative honest choice; a UX owner may
            // prefer a skeleton or an explicit "prices unavailable" affordance.
            amount={
              !pricesLoaded(tokenPrices) || balance === null ? (
                '—'
              ) : (
                // Keyed by the account: a switch lands on the new account's total instead of
                // counting from the old one's (AnimatedNumber counts only within one subject).
                <AnimatedNumber key={address} value={balance.toNumber()} format={usdTotal} />
              )
            }
            // Until the first balance read lands the store has no entry for this
            // address and `useAllBalances` hands back a zero placeholder, so the
            // card shows its skeleton, not a "0.00" that reads as lost funds (#844).
            state={balancesLoading ? 'loading' : 'default'}
            currency="USD"
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
        fundingNotes={fundingNotes}
        tokenPrices={tokenPrices}
      />

      <div className="flex items-center justify-between pt-2">
        <span id={assetsHeadingId} className="font-heading text-2xl font-extrabold text-text-primary-token">
          {t('assets')}
        </span>
      </div>

      <div
        className="flex flex-col divide-y divide-rule-default"
        data-testid="asset-list"
        role="group"
        aria-busy={balancesLoading}
        aria-labelledby={assetsHeadingId}
        // Focusable so an unhide that empties the Hidden assets section has somewhere to land.
        ref={assetListRef}
        tabIndex={-1}
      >
        {/* The hook's zero placeholder is not a balance: under the loading card it read as an empty wallet (#1123). */}
        {balancesLoading ? (
          <AssetListItemSkeleton data-testid="asset-row-skeleton" />
        ) : (
          sortedTokens.map(asset => (
            <AssetRow
              // Keyed by the account too, for the same reason as the total: a new account's row lands.
              key={`${address}:${asset.tokenId}`}
              asset={asset}
              tokenPrices={tokenPrices}
              onClick={() => navigate(`/token-detail/${asset.tokenId}`)}
            />
          ))
        )}
      </div>

      {!balancesLoading && (
        <HiddenAssets
          key={address}
          tokens={hiddenTokens}
          tokenPrices={tokenPrices}
          onUnhide={onUnhide}
          assetListRef={assetListRef}
        />
      )}
    </>
  );
};

interface HiddenAssetsProps {
  tokens: TokenBalanceData[];
  tokenPrices: TokenPrices;
  onUnhide: (tokenId: string) => Promise<boolean>;
  assetListRef: RefObject<HTMLDivElement>;
}

/** The held tokens the user hid (#813), folded under the asset list: each opens its page or comes back. */
const HiddenAssets: FC<HiddenAssetsProps> = ({ tokens, tokenPrices, onUnhide, assetListRef }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // The last Unhide's own result (#813): the hook reports none, only what each call resolves with.
  const [unhideFailed, setUnhideFailed] = useState(false);
  // Unhides started here and not yet resolved: their optimistic empty state is not the section emptying.
  const [pendingUnhides, setPendingUnhides] = useState(0);
  const listId = useId();
  const reveal = usePreset('reveal');
  const turn = useMotion(springs.standard);
  const unhideButtons = useRef<Map<string, HTMLButtonElement>>(new Map());
  // A tapped row counts as gone, for the focus hand-off and for further taps, until its Unhide settles:
  // it stays listed until the store's optimistic entry lands.
  const inFlightUnhides = useRef<Set<string>>(new Set());

  // The section stays mounted (returning null) while `tokens` is empty, so a hidden token
  // reappearing later would otherwise come back open with a stale error: collapse and drop it now.
  // Not while an unhide of its own is pending: a failed one rolls back into the open section with its error.
  useEffect(() => {
    if (tokens.length === 0 && pendingUnhides === 0) {
      setOpen(false);
      setUnhideFailed(false);
    }
  }, [tokens.length, pendingUnhides]);

  if (tokens.length === 0) return null;

  return (
    <section data-testid="hidden-assets" className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        data-testid="hidden-assets-toggle"
        onClick={() => {
          hapticLight();
          setOpen(value => !value);
        }}
        className="flex min-h-11 w-full items-center justify-between px-1 text-left text-label text-muted focus-visible:outline-accent-primary"
      >
        {t('hiddenAssetsCount', { count: tokens.length })}
        {/* `initial={false}` mounts the chevron at rest, so it turns only in answer to a tap. */}
        <motion.span
          aria-hidden
          className="flex h-6 w-6 shrink-0 items-center justify-center"
          initial={false}
          animate={{ rotate: open ? 180 : 0 }}
          transition={turn}
        >
          <Icon name={IconName.ChevronDown} size="sm" fill="currentColor" />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="hidden-asset-list"
            id={listId}
            role="region"
            aria-label={t('hiddenAssets')}
            {...reveal}
            className="overflow-hidden"
          >
            <div className="flex flex-col divide-y divide-rule-default" data-testid="hidden-asset-list">
              {tokens.map((asset, index) => (
                <div key={asset.tokenId} className="flex items-center gap-2">
                  {/* No sparkline: beside Unhide at the popup's width it would leave the name about 25px. */}
                  <div className="min-w-0 flex-1">
                    <AssetRow
                      asset={asset}
                      tokenPrices={tokenPrices}
                      sparkline={false}
                      onClick={() => navigate(`/token-detail/${asset.tokenId}`)}
                    />
                  </div>
                  <TextAction
                    ref={el => {
                      if (el) unhideButtons.current.set(asset.tokenId, el);
                      else unhideButtons.current.delete(asset.tokenId);
                    }}
                    className="shrink-0"
                    aria-label={t('unhideTokenLabel', { name: asset.metadata.name || asset.metadata.symbol })}
                    onClick={() => {
                      const inFlight = inFlightUnhides.current;
                      if (inFlight.has(asset.tokenId)) return;
                      // Focus moves now: this button unmounts with its row, and both targets exist at the click.
                      const neighbour =
                        tokens.slice(index + 1).find(token => !inFlight.has(token.tokenId)) ??
                        tokens
                          .slice(0, index)
                          .reverse()
                          .find(token => !inFlight.has(token.tokenId));
                      if (neighbour) unhideButtons.current.get(neighbour.tokenId)?.focus();
                      else assetListRef.current?.focus();
                      inFlight.add(asset.tokenId);
                      setPendingUnhides(count => count + 1);
                      void onUnhide(asset.tokenId)
                        .then(succeeded => {
                          setUnhideFailed(!succeeded);
                          setPendingUnhides(count => count - 1);
                        })
                        .finally(() => inFlight.delete(asset.tokenId));
                    }}
                  >
                    {t('unhide')}
                  </TextAction>
                </div>
              ))}
            </div>
            <ErrorLine data-testid="hidden-assets-error">{unhideFailed ? t('hiddenTokensError') : null}</ErrorLine>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
};
