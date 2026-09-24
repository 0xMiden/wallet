import React, { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { useActivityHiddenNotes } from 'app/hooks/useActivityHiddenNotes';
import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import useVerificationBaseFee from 'app/hooks/useVerificationBaseFee';
import { IconName } from 'app/icons/v2';
import { ACTIVITY_PENDING_PATH } from 'app/pages/activity-paths';
import { GuardianNeedsUrlBanner } from 'app/templates/GuardianNeedsUrlBanner';
import { PromptCard, PromptCardHero, PromptCardStatus, PromptCarousel, PromptCardVariant } from 'components/ui';
import { formatUsd } from 'lib/i18n/numbers';
import { initiateReplaceHotKeyTransaction, requestSWTransactionProcessing } from 'lib/miden/activity';
import { hasNoFeeAsset } from 'lib/miden/fees/spendable';
import type { TokenBalanceData } from 'lib/miden/front';
import { zustandProvider } from 'lib/miden/front/guardian-sync';
import { FaucetOutcomeUnknownError } from 'lib/miden-chain/faucet-api';
import { isExtension } from 'lib/platform';
import type { TokenPrices } from 'lib/prices';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { WalletAccount } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';
import useIsMounted from 'lib/ui/useIsMounted';
import {
  fetchActiveBridgePrompts,
  faucet,
  FAUCET_FUNDS_ARRIVAL_TIMEOUT_MS,
  FAUCET_UNSUBMITTED_MARKER_MS,
  faucetArrivalWindowStart,
  type FaucetFundingMarker,
  fetchFaucetFundingMarker,
  fetchHotKeyHardwareError,
  getFaucetRequestSettledAt,
  getInFlightFaucetMarker,
  FaucetRequestInProgressError,
  getInFlightFaucetRequest,
  getPendingNotesUsdTotal,
  isFaucetFundingMarkerLive,
  type PendingNoteValue,
  setFaucetFundingMarker,
  useGuardianNoteRecoveryProgress,
  useWalletPromptStorage,
  WalletPromptStatus,
  WalletPromptType,
  withFaucetFundingMarkerLock
} from 'lib/wallet-prompts';
import { navigate } from 'lib/woozie';

type PromptCardOverrides = {
  body?: string;
  bodyValue?: string;
  // Overrides `definition.dismissible`. `onDismiss: undefined` cannot express this,
  // because the render falls through to the definition's default dismiss handler.
  dismissible?: boolean;
  status?: PromptCardStatus;
  hero?: PromptCardHero;
  onClick?: () => void;
  onAction?: () => void;
  onDismiss?: () => void;
  actionDisabled?: boolean;
};

type WalletPromptDefinition = {
  titleKey: string;
  bodyKey: string;
  route?: string;
  actionKey?: string;
  variant?: PromptCardVariant;
  icon?: IconName;
  dismissible: boolean;
};

const WALLET_PROMPT_DEFINITIONS: Record<WalletPromptType, WalletPromptDefinition> = {
  [WalletPromptType.GuardianNoteRecovery]: {
    titleKey: 'guardianNoteRecoveryPromptTitle',
    bodyKey: 'guardianNoteRecoveryTransportStep',
    dismissible: false
  },
  [WalletPromptType.Bridge]: {
    titleKey: 'bridgePromptTitle',
    bodyKey: 'bridgePromptBody',
    dismissible: true
  },
  [WalletPromptType.Faucet]: {
    titleKey: 'faucetPromptTitle',
    bodyKey: 'faucetPromptBody',
    icon: IconName.Coins,
    dismissible: true
  },
  [WalletPromptType.PendingNotes]: {
    titleKey: 'pendingNotesPromptTitle',
    bodyKey: 'pendingNotesPromptBody',
    // Not dismissible: money waiting to be accepted is not a notice to be swept away, and a
    // wallet that dismissed it once must not go quiet about every later transfer.
    dismissible: false
  },
  [WalletPromptType.VerifySeedPhrase]: {
    titleKey: 'verifySeedPhrasePromptTitle',
    bodyKey: 'verifySeedPhrasePromptBody',
    route: '/settings/verify-seed-phrase',
    variant: 'warning',
    dismissible: true
  },
  [WalletPromptType.HotKeyHardwareUnavailable]: {
    titleKey: 'hotKeyHardwareErrorPromptTitle',
    bodyKey: 'hotKeyHardwareErrorPromptBody',
    actionKey: 'hotKeyHardwareErrorPromptAction',
    variant: 'critical',
    dismissible: true
  },
  [WalletPromptType.HotKeyRotationNeeded]: {
    titleKey: 'hotKeyRotationPromptTitle',
    bodyKey: 'hotKeyRotationPromptBody',
    actionKey: 'hotKeyRotationPromptAction',
    variant: 'critical',
    dismissible: true
  }
};

// The persisted per-account marker plus the account it belongs to, so every
// consumer (display, arrival, backstop) can refuse a wait that isn't the
// current account's.
// `settledAt` is when this surface saw the request go out (accepted, or unanswered):
// the arrival backstop counts from it, since a request can settle long after it was
// asked for when the app was away in between.
type FundingWait = FaucetFundingMarker & { address: string; settledAt?: number };
// Records that the wait's request went out, so the wait runs to the arrival backstop
// instead of ending with the request's own timeout. Touches only that request's wait.
const submittedWait =
  (address: string, requestedAt: number, settledAt?: number, submittedAt?: number) =>
  (current: FundingWait | null): FundingWait | null =>
    current !== null && current.address === address && current.requestedAt === requestedAt
      ? {
          ...current,
          submitted: true,
          settledAt: settledAt ?? current.settledAt,
          submittedAt: submittedAt ?? current.submittedAt
        }
      : current;
// Clears the stored marker only while it is still this request's: another surface
// may have started a newer request since, and that marker is not this wait's to end.
// Read and cleared under the marker lock, so that request cannot land in between.
const clearOwnFundingMarker = (address: string, requestedAt: number) =>
  withFaucetFundingMarkerLock(address, async () => {
    const stored = await fetchFaucetFundingMarker(address);
    if (stored?.requestedAt === requestedAt) await setFaucetFundingMarker(address, null);
  }).catch(error => console.warn('[wallet-prompts] failed to clear faucet funding marker:', error));
// How long the "Funds deposited" success beat holds before the prompt
// completes — long enough to read the two-line lockup.
const FAUCET_FUNDED_BEAT_MS = 2400;

// E2E hooks, kebab-case like every other testid in the tree. Only prompts a
// spec actually reads get one - deriving an id for the whole enum would leave
// four that nothing reads. Pending notes is read by
// playwright/e2e/helpers/home-prompts.ts: it is the only notice a user gets for
// a transfer that never accepts itself, so the multi-claim journeys check that
// it is the slide actually on screen.
const WALLET_PROMPT_TEST_IDS: Partial<Record<WalletPromptType, string>> = {
  [WalletPromptType.PendingNotes]: 'pending-notes-prompt'
};

const WALLET_PROMPT_ORDER = [
  WalletPromptType.GuardianNoteRecovery,
  WalletPromptType.PendingNotes,
  WalletPromptType.Bridge,
  WalletPromptType.HotKeyRotationNeeded,
  WalletPromptType.HotKeyHardwareUnavailable,
  WalletPromptType.Faucet,
  WalletPromptType.VerifySeedPhrase
] as const;

interface HomePromptsProps {
  account: WalletAccount;
  balances: TokenBalanceData[];
  balancesLoading: boolean;
  // Attention list for the pending-notes card: with auto-consume on it EXCLUDES
  // the native notes the auto-consumer claims.
  claimableNotes: readonly PendingNoteValue[] | undefined;
  // The unfiltered claimable list, for the faucet lifecycle only. The faucet mints
  // native MIDEN, which is exactly what the attention list drops while
  // auto-consume is on (the default), so grading arrival against it never saw the
  // mint land and left arrival to the balance alone.
  fundingNotes: readonly PendingNoteValue[] | undefined;
  tokenPrices: TokenPrices;
}

export const HomePrompts: FC<HomePromptsProps> = ({
  account,
  balances,
  balancesLoading,
  claimableNotes,
  fundingNotes,
  tokenPrices
}) => {
  const { t } = useTranslation();
  const seedStatus = useWalletStore(s => s.seedPhraseStatus);
  const { storage, isLoaded, setFaucetStatus, dismissPrompt, completePrompt, isPromptPending } =
    useWalletPromptStorage();
  const [faucetStatusIndicator, setFaucetStatusIndicator] = useState<PromptCardStatus>('idle');
  // Non-null between a successful faucet request and the minted funds becoming
  // visible (a claimable note or a balance). The faucet API acks in ~1s but
  // the note takes ~30-60s of chain inclusion + sync to appear; without this
  // the card vanished on ack and the wallet looked idle for that whole gap.
  // Tagged with the requesting account (the wait must never surface on another
  // account — HomePrompts is NOT remounted on switch), the request time (the
  // arrival backstop anchors to it, even across restarts) and the note ids
  // that already existed at request time (arrival requires a NEW note, so a
  // pre-existing claimable note can't fake an instant success).
  const [fundingWait, setFundingWait] = useState<FundingWait | null>(null);
  const awaitingFaucetFunds = fundingWait !== null && fundingWait.address === account.publicKey;
  // Brief "Funded!" success beat once the funds land, before the prompt
  // completes and the card hands off.
  // Tagged with the account whose funds landed, exactly like `fundingWait`: an
  // untagged flag had to be reset on every account switch, which cancelled the
  // beat's timer before it could complete the prompt - so switching away
  // mid-beat left the prompt Pending and re-offered a Fund tap for funds that
  // had already arrived.
  const [fundsArrivedFor, setFundsArrivedFor] = useState<string | null>(null);
  const faucetFundsArrived = fundsArrivedFor !== null && fundsArrivedFor === account.publicKey;
  // The faucet's actual failure reason, rendered in the card body — a bare red
  // X can't distinguish a rate limit from an outage (#425).
  const [faucetError, setFaucetError] = useState<string | null>(null);
  // Whether this account's persisted funding marker has been read on THIS visit.
  // Until then a wait may still be about to resume - a mint that acked before a
  // remount has no in-flight join left - so offering Fund could start a second
  // real mint. Keyed by visit, not just address: after A -> B -> A an address-only
  // proof from A's first visit would re-expose Fund before A's marker was re-read.
  const [markerRead, setMarkerRead] = useState({ address: account.publicKey, settled: false });
  if (markerRead.address !== account.publicKey) {
    // Reset during render, not in an effect, so no commit ever shows the new
    // account as ready on the previous visit's proof. The failure status and its
    // message belong to the previous visit too and are reset in the same pass: an
    // after-commit reset let the new account's first commit read the old failure,
    // which settled its readiness without a read and painted the other account's
    // error on its card.
    setMarkerRead({ address: account.publicKey, settled: false });
    setFaucetStatusIndicator('idle');
    setFaucetError(null);
  }
  // One subscription for one value: each call owns state, runs an async settings
  // lookup and subscribes to native-asset changes, and both consumers here -
  // arrival filtering and the fee-asset gate - want the same current id.
  const midenFaucetId = useMidenFaucetId();
  const accountKeyRef = useRef(account.publicKey);
  accountKeyRef.current = account.publicKey;

  const [hotKeyError, setHotKeyError] = useState<string | null>(null);
  const [copyStatusIndicator, setCopyStatusIndicator] = useState<PromptCardStatus>('idle');
  const copyTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const isMounted = useIsMounted();
  const [rotationStatusIndicator, setRotationStatusIndicator] = useState<PromptCardStatus>('idle');
  const rotatingRef = useRef(false);
  const [bridgeTransactions, setBridgeTransactions] = useState<string[]>([]);
  const noteRecoveryProgress = useGuardianNoteRecoveryProgress(
    account.guardianNoteRecoveryPending === true ? account.publicKey : null
  );
  const bridgePromptPending = isPromptPending(WalletPromptType.Bridge);
  const hotKeyPromptPending = isPromptPending(WalletPromptType.HotKeyHardwareUnavailable);
  // A DECLINED transfer is not waiting for anything. It stays claimable — declining only hides
  // it, and Restore brings it back — so the raw claimable list still contains it, and the banner
  // counted it and added its value to the total the user was told was waiting. The Pending tab's
  // "Hidden transfers — Restore" row reads the same set; this is what makes the two agree.
  const hiddenNotes = useActivityHiddenNotes(account.publicKey);
  // `ids` is empty until the set has been read, so the banner waits rather than announcing a
  // total it is about to revise down. An unreadable set settles too: it is `failed`, not pending
  // forever, and the banner falls back to showing everything.
  const hiddenSettled = hiddenNotes.loaded || hiddenNotes.failed;
  const waitingNotes = useMemo(
    () => (claimableNotes ?? []).filter(note => !hiddenNotes.ids.has(note.id)),
    [claimableNotes, hiddenNotes.ids]
  );
  const pendingNoteIds = useMemo(() => waitingNotes.map(note => note.id), [waitingNotes]);
  const hasPendingNotes = pendingNoteIds.length > 0;
  const showPendingNotesPrompt = isLoaded && hiddenSettled && hasPendingNotes;
  const fundingNoteIds = useMemo(() => fundingNotes?.map(note => note.id) ?? [], [fundingNotes]);
  const formattedFundingNotesUsdTotal = useMemo(
    () => formatUsd(getPendingNotesUsdTotal(fundingNotes ?? [], tokenPrices)),
    [fundingNotes, tokenPrices]
  );
  const formattedPendingNotesUsdTotal = useMemo(
    () => formatUsd(getPendingNotesUsdTotal(waitingNotes, tokenPrices)),
    [waitingNotes, tokenPrices]
  );

  // One localized line per recovery step; the public-backfill step carries the
  // live block progress the SW reports after each scanned chunk.
  const noteRecoveryBody = useMemo(() => {
    if (!noteRecoveryProgress) return undefined;
    switch (noteRecoveryProgress.step) {
      case 'transport':
        return t('guardianNoteRecoveryTransportStep');
      case 'proposals':
        return t('guardianNoteRecoveryProposalsStep');
      case 'public': {
        const { syncedToBlock, latestBlock } = noteRecoveryProgress;
        if (syncedToBlock === undefined || latestBlock === undefined) {
          return t('guardianNoteRecoveryPublicPreparingStep');
        }
        return t('guardianNoteRecoveryPublicStep', {
          current: syncedToBlock.toLocaleString(),
          latest: latestBlock.toLocaleString()
        });
      }
    }
  }, [noteRecoveryProgress, t]);

  const verificationBaseFee = useVerificationBaseFee();
  // "Funded" has to mean "can transact". On a fee-charging chain that is the
  // NATIVE balance specifically -- an account holding only other tokens cannot
  // move them, so it still needs the faucet. `hasNoFeeAsset` fails open, so a
  // zero-fee chain keeps the original any-token behaviour.
  const hasBalance = useMemo(
    () => balances.some(token => token.balance > 0) && !hasNoFeeAsset(balances, midenFaucetId, verificationBaseFee),
    [balances, midenFaucetId, verificationBaseFee]
  );
  // Per account: one account's completion or dismiss must not hide Fund on another.
  const faucetStatus = storage.faucetByAccount[account.publicKey];
  // Dismiss means "not now", not "never again". An account that has run its native
  // balance to zero on a fee-charging chain cannot transact at all, and this prompt
  // is the way out -- so a previous dismissal stops suppressing it. Without the
  // re-arm the user is left stuck with no affordance anywhere on Home.
  const cannotPayFee = hasNoFeeAsset(balances, midenFaucetId, verificationBaseFee);
  const faucetIsTerminal =
    !cannotPayFee && (faucetStatus === WalletPromptStatus.Dismissed || faucetStatus === WalletPromptStatus.Completed);
  const showFaucetPrompt =
    awaitingFaucetFunds || faucetFundsArrived || (isLoaded && !balancesLoading && !hasBalance && !faucetIsTerminal);

  useEffect(
    () => () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    },
    []
  );

  useEffect(() => {
    if (!hotKeyPromptPending) return;
    let cancelled = false;
    fetchHotKeyHardwareError()
      .then(record => {
        if (!cancelled) setHotKeyError(record?.message ?? null);
      })
      .catch(error => {
        console.warn('[wallet-prompts] failed to load hot-key hardware error:', error);
      });
    return () => {
      cancelled = true;
    };
  }, [hotKeyPromptPending]);

  useEffect(() => {
    if (!isLoaded || !bridgePromptPending) {
      setBridgeTransactions([]);
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const active = await fetchActiveBridgePrompts(account.publicKey);
        if (cancelled) return;
        if (active.length === 0) {
          setBridgeTransactions([]);
          completePrompt(WalletPromptType.Bridge);
          return;
        }

        // The app-root `BridgeIntentWatcher` polls the rows; this loop only
        // re-reads them so the card follows the settlement it writes.
        setBridgeTransactions(active.map(tx => tx.id));
      } catch (error) {
        console.warn('[wallet-prompts] bridge poll failed:', error);
      }
      if (!cancelled) timer = setTimeout(tick, 8000);
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [account.publicKey, bridgePromptPending, completePrompt, isLoaded]);

  const copyHotKeyError = useCallback(() => {
    const text = hotKeyError ?? 'Hot-key secure hardware unavailable';
    // The write is owned by an async function: a bare `navigator.clipboard` dereference throws
    // synchronously where the API is absent, and the `.catch` below - the only thing that reports
    // a failure - would never have been attached to anything.
    void (async () => {
      await navigator.clipboard.writeText(text);
    })()
      .then(() => {
        // The timer below is armed AFTER the awaited write, so the unmount cleanup has already run
        // and found nothing to clear by the time this continuation lands. Liveness has to be
        // checked here, not just cleaned up there.
        if (!isMounted()) return;
        setCopyStatusIndicator('success');
        if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
        copyTimerRef.current = setTimeout(() => setCopyStatusIndicator('idle'), 1500);
      })
      .catch(error => {
        console.error('[wallet-prompts] failed to copy hot-key error:', error);
        if (!isMounted()) return;
        setCopyStatusIndicator('failure');
      });
  }, [hotKeyError, isMounted]);

  // Rotation-needed prompt action: enqueue a replace-hot-key transaction and
  // route to the generating-transaction page (which drives the FIFO loop on
  // mobile/desktop; on extension the SW owns it). Mirrors ReviewTransaction's
  // initiate-then-navigate shape. The prompt completes on successful initiate —
  // if the rotation transaction itself later fails, the next failing sign
  // re-arms the prompt (see reportHotKeyRotationNeeded).
  const rotateHotKey = useCallback(async () => {
    if (rotatingRef.current) return;
    rotatingRef.current = true;
    setRotationStatusIndicator('loading');
    try {
      const txId = await initiateReplaceHotKeyTransaction(account.publicKey, isDelegateProofEnabled(), zustandProvider);
      completePrompt(WalletPromptType.HotKeyRotationNeeded);
      if (isExtension()) requestSWTransactionProcessing();
      navigate(`/generating-transaction/${txId}`);
    } catch (error) {
      console.error('[wallet-prompts] hot-key rotation initiate failed:', error);
      setRotationStatusIndicator('failure');
    } finally {
      rotatingRef.current = false;
    }
  }, [account.publicKey, completePrompt]);

  useEffect(() => {
    if (!isLoaded || balancesLoading) return;
    if (!hasBalance && faucetStatus === undefined) {
      setFaucetStatus(account.publicKey, WalletPromptStatus.Pending);
    } else if (
      hasBalance &&
      faucetStatus === WalletPromptStatus.Pending &&
      // Let the Funding → Funded! sequence own completion for our own request.
      !awaitingFaucetFunds &&
      !faucetFundsArrived
    ) {
      setFaucetStatus(account.publicKey, WalletPromptStatus.Completed);
    }
  }, [
    account.publicKey,
    awaitingFaucetFunds,
    balancesLoading,
    faucetFundsArrived,
    faucetStatus,
    hasBalance,
    isLoaded,
    setFaucetStatus
  ]);

  // An account switch re-renders this component in place (it is not keyed by
  // account) — drop any other account's on-screen funding presentation. Its
  // persisted marker is left untouched, so switching back resumes it via the
  // resume effect below.
  useEffect(() => {
    setFundingWait(current => (current !== null && current.address !== account.publicKey ? null : current));
  }, [account.publicKey]);

  // Re-attach to a request still running at module scope after a remount
  // (HomePrompts unmounts on any navigation): show the loading state again, wait
  // for the mint once it went out, and paint the failure if it was refused.
  useEffect(() => {
    const address = account.publicKey;
    const inFlight = getInFlightFaucetRequest(address);
    if (!inFlight) return;
    // Taken now: the request's entry is gone once it settles.
    const marker = getInFlightFaucetMarker(address);
    let cancelled = false;
    setFaucetStatusIndicator('loading');
    // The request went out: it succeeded, or it was sent and never answered. The wait
    // for its mint is installed from the marker it was started with before going idle;
    // idling first, or depending on a storage read, could offer Fund while the mint lands.
    const settleSent = () => {
      if (cancelled || accountKeyRef.current !== address) return;
      if (marker) {
        setFundingWait(current =>
          current !== null && current.address !== address
            ? current
            : { address, ...marker, submitted: true, settledAt: Date.now() }
        );
      }
      setFaucetStatusIndicator('idle');
    };
    inFlight.then(settleSent, (error: unknown) => {
      if (cancelled) return;
      if (error instanceof FaucetOutcomeUnknownError) {
        settleSent();
        return;
      }
      if (error instanceof FaucetRequestInProgressError) {
        // Nothing was sent: another surface's request is still live. Wait for its mint.
        if (accountKeyRef.current !== address) return;
        const running = error.marker;
        setFundingWait(current =>
          current !== null && current.address !== address ? current : { address, ...running }
        );
        setFaucetStatusIndicator('idle');
        return;
      }
      // The rejection belongs to `address`, not to whoever is on screen: drop
      // that account's wait unconditionally (the updater is already
      // address-matched), or switching back to it restores a Funding hero with
      // no request behind it until the backstop fires.
      setFundingWait(current => (current !== null && current.address === address ? null : current));
      if (accountKeyRef.current !== address) return;
      setFaucetStatusIndicator('failure');
      setFaucetError(error instanceof Error ? error.message : String(error));
    });
    return () => {
      cancelled = true;
    };
  }, [account.publicKey]);

  const fundWallet = useCallback(async () => {
    const address = account.publicKey;
    // A second tap (or a tap from a remount) joins the request already running
    // at module scope instead of starting a second real mint.
    if (getInFlightFaucetRequest(address)) return;
    // Don't arm a wait against an unloaded note set: the note list is SWR
    // data and undefined until its first load resolves, so a baseline
    // snapshotted now would treat every pre-existing note as the arriving
    // mint the moment the load lands. The card is not offered as actionable
    // until the set has loaded (see `fundingReady`), so this is an invariant,
    // not a path a tap can take.
    if (fundingNotes === undefined) return;
    // Snapshot the notes that already exist: only a note beyond this baseline
    // (or a balance) counts as the mint landing.
    const baselineNoteIds = fundingNoteIds;
    // Identifies this request. It anchors only the wait while the request is unsent; once it
    // goes out, the arrival window runs from its settle (see the backstop).
    const requestedAt = Date.now();
    const marker: FaucetFundingMarker = { requestedAt, baselineNoteIds };
    setFaucetStatusIndicator('loading');
    setFaucetError(null);
    // Installed before anything is awaited, so the account on screen is still the
    // one asking - no switch can have happened yet.
    setFundingWait({ address, ...marker });
    try {
      // The request persists the marker, so a card that unmounts over it still
      // resumes the wait, and flags it submitted before the token request goes out.
      await faucet(address, marker);
      setFundingWait(submittedWait(address, requestedAt, Date.now()));
      if (accountKeyRef.current === address) setFaucetStatusIndicator('idle');
    } catch (error) {
      if (error instanceof FaucetRequestInProgressError) {
        // This card read no marker before another surface's request started, and that
        // request is still live: nothing was sent, so wait for its mint, as a remount would.
        const running = error.marker;
        setFundingWait(current =>
          current !== null && current.address === address && current.requestedAt === requestedAt
            ? { address, ...running }
            : current
        );
        if (accountKeyRef.current === address) setFaucetStatusIndicator('idle');
        return;
      }
      if (error instanceof FaucetOutcomeUnknownError) {
        // The token request went out and was never answered. The faucet may have
        // minted, and a retry would mint again - so keep the flagged marker and the
        // wait: arrival resolves it, or the backstop gives the card back.
        console.warn('[wallet-prompts] faucet request outcome unknown; waiting for the mint:', error);
        setFundingWait(submittedWait(address, requestedAt, Date.now()));
        if (accountKeyRef.current === address) setFaucetStatusIndicator('idle');
        return;
      }
      // The request failed, so its marker no longer describes an expected mint: clear
      // it for WHATEVER account made the request…
      clearOwnFundingMarker(address, requestedAt);
      // …and drop that account's wait whoever is on screen, for the same reason.
      setFundingWait(current => (current !== null && current.address === address ? null : current));
      // …but only paint the failure if that account is still on screen.
      if (accountKeyRef.current === address) {
        setFaucetStatusIndicator('failure');
        setFaucetError(error instanceof Error ? error.message : String(error));
      }
      console.error('[wallet-prompts] faucet request failed:', error);
    }
  }, [account.publicKey, fundingNoteIds, fundingNotes]);

  // Resume the "Funding" wait after a remount, app restart, or switch back to
  // this account: a persisted, still-fresh request marker means the mint is in
  // flight (or already landed, in which case the arrival effect below fires
  // immediately).
  useEffect(() => {
    if (!isLoaded || balancesLoading || awaitingFaucetFunds || faucetFundsArrived || faucetIsTerminal) return;
    // A just-painted failure clears the marker without awaiting the write, so a
    // read issued around it can still see the old marker. Re-arming on that
    // would bury the failure under a Funding hero until the backstop.
    if (faucetStatusIndicator === 'failure') {
      // A failure clears the marker, so there is nothing left to resume: the read
      // is settled. Without this, a request that failed before the first read
      // settled cancelled that read and left the failure card with no retry.
      setMarkerRead(current => (current.address === account.publicKey ? { ...current, settled: true } : current));
      return;
    }
    const address = account.publicKey;
    let cancelled = false;
    // Read, decided and cleared under the marker lock: a marker judged abandoned here is gone
    // before another surface can store a new request's marker in its place.
    withFaucetFundingMarkerLock(address, async () => {
      const marker = await fetchFaucetFundingMarker(address);
      if (cancelled) return;
      if (marker !== null) {
        // An unflagged marker past its request timeout, with nothing running here, was
        // left by a realm that died before the token request went out (an extension
        // popup closed during the proof of work, an app killed), so nothing was minted.
        // A younger one is waited on; the backstop re-decides it once that timeout passes.
        const settledAt = getFaucetRequestSettledAt(address, marker.requestedAt);
        if (isFaucetFundingMarkerLive(marker, { runningHere: getInFlightFaucetRequest(address) !== null, settledAt })) {
          setFundingWait({ address, ...marker, settledAt: settledAt ?? undefined });
        } else {
          await setFaucetFundingMarker(address, null).catch(error =>
            console.warn('[wallet-prompts] failed to clear faucet funding marker:', error)
          );
        }
      }
      setMarkerRead(current => (current.address === address ? { address, settled: true } : current));
    }).catch(error => {
      console.warn('[wallet-prompts] failed to read faucet funding marker; offering Fund for', address, error);
      // An unreadable marker must not disable funding for good; the read is settled and Fund
      // is offered (#936). Safe because a tap re-reads the marker under the lock before any
      // proof of work: a read that fails again refuses the request, and a request already on
      // its way refuses it too.
      if (!cancelled) setMarkerRead(current => (current.address === address ? { address, settled: true } : current));
    });
    return () => {
      cancelled = true;
    };
  }, [
    account.publicKey,
    awaitingFaucetFunds,
    balancesLoading,
    faucetFundsArrived,
    faucetIsTerminal,
    faucetStatusIndicator,
    isLoaded
  ]);

  // Funds arrived — a NEW claimable note from the native MIDEN faucet (the
  // request only ever mints native), or a balance (the card only exists on a
  // zero-balance account, so any balance is new): swap the "Funding" hero for
  // a short "Funded!" success beat. Requiring the native faucet keeps an
  // unrelated inbound note — or a pre-existing note whose metadata resolved
  // late and only just joined the list - from faking the success.
  useEffect(() => {
    if (!awaitingFaucetFunds || fundingWait === null) return;
    // Only the note comparison needs the note set: an unloaded set can't be
    // graded against the baseline. A balance is independent of it, and gating it
    // here held the Funding hero - up to the 3-minute backstop - while spendable
    // funds were already visible.
    const baseline = new Set(fundingWait.baselineNoteIds);
    const hasNewNote =
      fundingNotes !== undefined &&
      midenFaucetId !== null &&
      fundingNotes.some(note => note.faucetId === midenFaucetId && !baseline.has(note.id));
    if (!hasNewNote && !hasBalance) return;
    setFundingWait(null);
    setFundsArrivedFor(fundingWait.address);
    clearOwnFundingMarker(fundingWait.address, fundingWait.requestedAt);
    // Complete the prompt NOW, in the same pass that clears the marker. Holding
    // completion for the beat's in-memory timer meant closing the app on the
    // "Funds deposited" screen - the natural thing to do - lost it: the marker was
    // already gone, the prompt stayed Pending, and the next open re-offered Fund
    // for a mint that had landed. `fundsArrivedFor` keeps the card on stage for
    // the beat regardless, so this changes nothing on screen.
    // Completed for the account whose funds landed, which is the one on screen.
    setFaucetStatus(fundingWait.address, WalletPromptStatus.Completed);
  }, [awaitingFaucetFunds, fundingNotes, fundingWait, hasBalance, midenFaucetId, setFaucetStatus]);

  // After the success beat, hand the stage to the pending-notes card / balance.
  // Pure presentation: the prompt was already completed at arrival.
  useEffect(() => {
    if (fundsArrivedFor === null) return;
    const timer = setTimeout(() => setFundsArrivedFor(null), FAUCET_FUNDED_BEAT_MS);
    return () => clearTimeout(timer);
  }, [fundsArrivedFor]);

  // Backstop: if the funds never show up (faucet acked but the mint failed),
  // fall back to the actionable card instead of spinning forever. A sent request's
  // window runs from when this surface saw it settle, else from when it went out, else
  // from the request time, never from this mount.
  useEffect(() => {
    if (!awaitingFaucetFunds || fundingWait === null) return;
    const { address, requestedAt, submitted, settledAt } = fundingWait;
    // A wait whose request is not known to have gone out can only matter until that
    // request's timeout; past it, storage says whether it went out after all.
    const limitMs = submitted ? FAUCET_FUNDS_ARRIVAL_TIMEOUT_MS : FAUCET_UNSUBMITTED_MARKER_MS;
    // Clamped to the limit itself: the stamp is persisted wall-clock, so a
    // backward clock step would otherwise make this arbitrarily large and hold
    // the hero - and the pending-notes suppression with it - well past 3 minutes.
    const anchor = submitted ? faucetArrivalWindowStart(fundingWait, settledAt) : requestedAt;
    const remainingMs = Math.min(limitMs, Math.max(0, anchor + limitMs - Date.now()));
    let cancelled = false;
    const timer = setTimeout(() => {
      if (submitted) {
        // Still running here, so not settled: its window has not started, and the settle
        // re-anchors this wait.
        if (getInFlightFaucetRequest(address) !== null) return;
        // Settled since this timer was armed, with the re-anchor not rendered yet (an overdue
        // timer after a resume): the wait runs from that settle.
        // Only a settle newer than the one this timer was armed from: re-arming on the same
        // settle would hold the wait for as long as a backward clock step keeps it in the future.
        const recordedSettle = getFaucetRequestSettledAt(address, requestedAt);
        if (recordedSettle !== null && recordedSettle > anchor) {
          setFundingWait(submittedWait(address, requestedAt, recordedSettle));
          return;
        }
        // Every other terminal path in this file logs; without this a hero that
        // silently reverts to the actionable card leaves no trail separating a
        // genuine 3-minute timeout from any other state reset.
        console.warn('[wallet-prompts] faucet funding wait timed out for', address);
        setFundingWait(current =>
          current !== null && current.address === address && current.requestedAt === requestedAt ? null : current
        );
        clearOwnFundingMarker(address, requestedAt);
        return;
      }
      // Read, decided and cleared under the marker lock, so the owner's submitted flag cannot
      // land between this read and the clear.
      withFaucetFundingMarkerLock(address, async () => {
        const stored = await fetchFaucetFundingMarker(address);
        if (cancelled) return;
        const sameRequest = stored !== null && stored.requestedAt === requestedAt;
        // Flagged since by whichever surface owns it, or still running here.
        if ((sameRequest && stored.submitted) || getInFlightFaucetRequest(address) !== null) {
          setFundingWait(
            submittedWait(
              address,
              requestedAt,
              getFaucetRequestSettledAt(address, requestedAt) ?? undefined,
              sameRequest ? stored.submittedAt : undefined
            )
          );
          return;
        }
        console.warn('[wallet-prompts] faucet request never went out; ending the wait for', address);
        setFundingWait(current =>
          current !== null && current.address === address && current.requestedAt === requestedAt ? null : current
        );
        if (sameRequest) {
          await setFaucetFundingMarker(address, null).catch(error =>
            console.warn('[wallet-prompts] failed to clear faucet funding marker:', error)
          );
        }
      }).catch(error => {
        if (cancelled) return;
        // Unreadable, so it may have gone out: wait for the mint rather than offer Fund.
        console.warn(
          '[wallet-prompts] failed to read faucet funding marker; keeping the funding wait for',
          address,
          error
        );
        setFundingWait(
          submittedWait(address, requestedAt, getFaucetRequestSettledAt(address, requestedAt) ?? undefined)
        );
      });
    }, remainingMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [awaitingFaucetFunds, fundingWait]);

  // While the faucet hero is on stage (Funding wait or the Funded! beat), the
  // pending-notes card must NOT surface: it sorts first in the carousel and
  // would shove the hero off-screen the instant the minted note lands, hiding
  // the success beat. It takes over right after the beat completes.
  // Gated on `showFaucetPrompt` too: `faucetStatusIndicator === 'loading'` can
  // outlive the card itself - if the native auto-consumer settles a note
  // mid-request, `hasBalance` flips, the seeding effect completes the prompt and
  // the faucet card unmounts, and pending-notes would stay suppressed behind a
  // hero that is no longer on stage.
  // The Fund card is offered only once it can act on the tap: the note set has
  // loaded (so the baseline is real) and this account's marker has been read (so
  // a wait that is about to resume can't be doubled). Until then it simply has no
  // action - no press-in, no haptic - rather than accepting a tap it would drop.
  // main's fee-broke re-arm shows the card again after completion on a
  // fee-charging chain, until the minted note is consumed. Offering Fund there
  // started a second real mint for money that had already arrived. Scoped to a
  // COMPLETED prompt: a first-time user may still fund while an unrelated native
  // note is claimable - the baseline exists precisely for that.
  const rearmedWhileMintClaimable =
    faucetStatus === WalletPromptStatus.Completed &&
    midenFaucetId !== null &&
    (fundingNotes ?? []).some(note => note.faucetId === midenFaucetId);

  const fundingReady = fundingNotes !== undefined && markerRead.address === account.publicKey && markerRead.settled;

  const faucetHeroActive =
    showFaucetPrompt && (awaitingFaucetFunds || faucetFundsArrived || faucetStatusIndicator === 'loading');

  const pendingWalletPrompts = useMemo(() => {
    if (!isLoaded || balancesLoading) return [];
    return WALLET_PROMPT_ORDER.filter(type => {
      if (type === WalletPromptType.VerifySeedPhrase && seedStatus && seedStatus !== 'stored') return false;
      if (type === WalletPromptType.GuardianNoteRecovery) return noteRecoveryProgress !== null;
      if (type === WalletPromptType.PendingNotes) return showPendingNotesPrompt && !faucetHeroActive;
      if (type === WalletPromptType.Faucet) return showFaucetPrompt;
      if (type === WalletPromptType.Bridge) return bridgePromptPending && bridgeTransactions.length > 0;
      return isPromptPending(type);
    }).map<[WalletPromptType, WalletPromptDefinition]>(type => [type, WALLET_PROMPT_DEFINITIONS[type]]);
  }, [
    balancesLoading,
    bridgePromptPending,
    bridgeTransactions.length,
    faucetHeroActive,
    isLoaded,
    isPromptPending,
    noteRecoveryProgress,
    showFaucetPrompt,
    showPendingNotesPrompt,
    seedStatus
  ]);

  // Per-type runtime behavior in one place; anything not set here falls back
  // to the static definition (route click, plain body, default dismiss).
  const promptOverrides = useCallback(
    (type: WalletPromptType): PromptCardOverrides => {
      switch (type) {
        case WalletPromptType.GuardianNoteRecovery:
          return {
            body: noteRecoveryBody,
            status: 'loading'
          };
        case WalletPromptType.Faucet: {
          const funding = awaitingFaucetFunds || faucetStatusIndicator === 'loading';
          return {
            onDismiss: () => setFaucetStatus(account.publicKey, WalletPromptStatus.Dismissed),
            // The whole card is the trigger; no CTA button. While the hero is
            // up (Funding / Funded!) taps are inert.
            onClick:
              funding || faucetFundsArrived || !fundingReady || rearmedWhileMintClaimable ? undefined : fundWallet,
            status: funding ? 'loading' : faucetFundsArrived ? 'success' : faucetStatusIndicator,
            // On failure the body carries the faucet's actual message, so a rate
            // limit, a rejected amount, and an outage read differently. Otherwise a
            // user holding tokens but no MIDEN reads "Add tokens" and reasonably
            // concludes the prompt is not about them -- name the missing asset.
            body:
              faucetStatusIndicator === 'failure' && faucetError
                ? faucetError
                : cannotPayFee
                  ? t('insufficientFeeAsset')
                  : undefined,
            // While the account cannot pay a fee this prompt re-arms on every render
            // (see `faucetIsTerminal`), so a dismiss X would write storage, fire haptics
            // and change nothing. Withhold the control rather than ship one that lies.
            dismissible: cannotPayFee ? false : undefined,
            hero: funding
              ? {
                  icon: IconName.Hourglass,
                  label: t('faucetPromptFunding'),
                  subLabel: t('faucetPromptFundingSub'),
                  tone: 'accent' as const
                }
              : faucetFundsArrived
                ? {
                    icon: IconName.Checkmark,
                    label: t('faucetPromptFunded'),
                    subLabel:
                      fundingNoteIds.length > 0
                        ? t('faucetPromptFundedSub', { amount: formattedFundingNotesUsdTotal })
                        : t('faucetPromptFundedSubGeneric'),
                    tone: 'positive' as const
                  }
                : undefined
          };
        }
        case WalletPromptType.Bridge:
          return {
            onClick: () => navigate(`/history-details/${bridgeTransactions[0]}`),
            status: 'loading'
          };
        case WalletPromptType.PendingNotes:
          return {
            onClick: () => navigate(ACTIVITY_PENDING_PATH),
            // The count carries the fact; the money is the `bodyValue`, so it is read rather
            // than scanned past in the middle of a sentence.
            body: t(WALLET_PROMPT_DEFINITIONS[type].bodyKey, { count: pendingNoteIds.length }),
            bodyValue: formattedPendingNotesUsdTotal
          };
        case WalletPromptType.HotKeyHardwareUnavailable:
          return {
            onAction: copyHotKeyError,
            status: copyStatusIndicator
          };
        case WalletPromptType.HotKeyRotationNeeded:
          return {
            onAction: rotateHotKey,
            status: rotationStatusIndicator,
            actionDisabled: rotationStatusIndicator === 'loading'
          };
        default:
          return {};
      }
    },
    [
      account.publicKey,
      awaitingFaucetFunds,
      // The fee-broke branch changes both the body and whether a dismiss control is
      // rendered, so a stale value would leave a user who has just run out of MIDEN
      // reading the generic prompt with a dead X.
      cannotPayFee,
      bridgeTransactions,
      noteRecoveryBody,
      copyHotKeyError,
      copyStatusIndicator,
      faucetError,
      faucetFundsArrived,
      faucetStatusIndicator,
      formattedFundingNotesUsdTotal,
      formattedPendingNotesUsdTotal,
      fundingReady,
      fundWallet,
      rearmedWhileMintClaimable,
      fundingNoteIds,
      pendingNoteIds,
      rotateHotKey,
      rotationStatusIndicator,
      setFaucetStatus,
      t
    ]
  );

  return (
    <PromptCarousel>
      {pendingWalletPrompts.map(([type, definition]) => {
        const overrides = promptOverrides(type);
        const route = definition.route;
        const testId = WALLET_PROMPT_TEST_IDS[type];
        return (
          <PromptCard
            key={type}
            data-testid={testId}
            actionTestId={testId ? `${testId}-action` : undefined}
            title={t(definition.titleKey)}
            body={overrides.body ?? t(definition.bodyKey)}
            bodyValue={overrides.bodyValue}
            variant={definition.variant}
            icon={definition.icon}
            hero={overrides.hero}
            onClick={overrides.onClick ?? (route && !overrides.onAction ? () => navigate(route) : undefined)}
            actionLabel={definition.actionKey ? t(definition.actionKey) : undefined}
            onAction={overrides.onAction}
            actionDisabled={overrides.actionDisabled ?? false}
            status={overrides.status}
            // Whether the card is dismissible decides alone; only then is the handler
            // chosen. The faucet case always supplies its own: its status is per account.
            onDismiss={
              (overrides.dismissible ?? definition.dismissible)
                ? (overrides.onDismiss ?? (type === WalletPromptType.Faucet ? undefined : () => dismissPrompt(type)))
                : undefined
            }
          />
        );
      })}
      {account.guardianSyncStatus === 'needs-user-input' && <GuardianNeedsUrlBanner />}
    </PromptCarousel>
  );
};

export default HomePrompts;
