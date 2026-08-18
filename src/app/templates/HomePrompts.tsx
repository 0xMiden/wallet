import React, { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import { IconName } from 'app/icons/v2';
import { GuardianNeedsUrlBanner } from 'app/templates/GuardianNeedsUrlBanner';
import { PromptCard, PromptCardHero, PromptCardStatus, PromptCarousel, PromptCardVariant } from 'components/ui';
import { formatUsd } from 'lib/i18n/numbers';
import { initiateReplaceHotKeyTransaction, requestSWTransactionProcessing } from 'lib/miden/activity';
import type { TokenBalanceData } from 'lib/miden/front';
import { zustandProvider } from 'lib/miden/front/guardian-sync';
import { isExtension } from 'lib/platform';
import type { TokenPrices } from 'lib/prices';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { WalletAccount } from 'lib/shared/types';
import {
  fetchActiveBridgePrompts,
  faucet,
  type FaucetFundingMarker,
  fetchFaucetFundingMarker,
  fetchHotKeyHardwareError,
  getInFlightFaucetRequest,
  getPendingNotesUsdTotal,
  type PendingNoteValue,
  pollActiveBridgePrompts,
  setFaucetFundingMarker,
  useWalletPromptStorage,
  WalletPromptStatus,
  WalletPromptType
} from 'lib/wallet-prompts';
import { navigate } from 'lib/woozie';

type PromptCardOverrides = {
  title?: string;
  body?: string;
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
    dismissible: true
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

// How long after a successful faucet request we keep showing the "Funding"
// hero before giving the user the Fund action back. Arrival normally takes
// ~30-60s (chain inclusion + client sync).
const FAUCET_FUNDS_ARRIVAL_TIMEOUT_MS = 3 * 60_000;

// The persisted per-account marker plus the account it belongs to, so every
// consumer (display, arrival, backstop) can refuse a wait that isn't the
// current account's.
type FundingWait = FaucetFundingMarker & { address: string };
// How long the "Funds deposited" success beat holds before the prompt
// completes — long enough to read the two-line lockup.
const FAUCET_FUNDED_BEAT_MS = 2400;

// E2E hooks, kebab-case like every other testid in the tree. Only prompts a
// spec actually drives get one — deriving an id for the whole enum would leave
// four that nothing reads. Pending notes is driven by
// playwright/e2e/tests/group-claim.spec.ts.
const WALLET_PROMPT_TEST_IDS: Partial<Record<WalletPromptType, string>> = {
  [WalletPromptType.PendingNotes]: 'pending-notes-prompt'
};

const WALLET_PROMPT_ORDER = [
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
  claimableNotes: readonly PendingNoteValue[] | undefined;
  tokenPrices: TokenPrices;
}

export const HomePrompts: FC<HomePromptsProps> = ({
  account,
  balances,
  balancesLoading,
  claimableNotes,
  tokenPrices
}) => {
  const { t } = useTranslation();
  const { storage, isLoaded, setPromptStatus, dismissPrompt, completePrompt, isPromptPending } =
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
  const [faucetFundsArrived, setFaucetFundsArrived] = useState(false);
  // The faucet's actual failure reason, rendered in the card body — a bare red
  // X can't distinguish a rate limit from an outage (#425).
  const [faucetError, setFaucetError] = useState<string | null>(null);
  const midenFaucetId = useMidenFaucetId();
  const accountKeyRef = useRef(account.publicKey);
  accountKeyRef.current = account.publicKey;

  const [hotKeyError, setHotKeyError] = useState<string | null>(null);
  const [copyStatusIndicator, setCopyStatusIndicator] = useState<PromptCardStatus>('idle');
  const copyTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const [rotationStatusIndicator, setRotationStatusIndicator] = useState<PromptCardStatus>('idle');
  const rotatingRef = useRef(false);
  const [bridgeTransactions, setBridgeTransactions] = useState<string[]>([]);
  const bridgePromptPending = isPromptPending(WalletPromptType.Bridge);
  const hotKeyPromptPending = isPromptPending(WalletPromptType.HotKeyHardwareUnavailable);
  const pendingNotesStatus = storage.prompts[WalletPromptType.PendingNotes];
  const pendingNoteIds = useMemo(() => claimableNotes?.map(note => note.id) ?? [], [claimableNotes]);
  const hasPendingNotes = pendingNoteIds.length > 0;
  // A dismiss hides the batch of note ids current at the time; the prompt
  // resurfaces once none of the currently-pending notes were in that batch.
  const hasDismissedBatchNote = useMemo(() => {
    if (pendingNotesStatus !== WalletPromptStatus.Dismissed) return false;
    const dismissedIds = new Set(storage.pendingNotesDismissedIds);
    return pendingNoteIds.some(noteId => dismissedIds.has(noteId));
  }, [pendingNoteIds, pendingNotesStatus, storage.pendingNotesDismissedIds]);
  const showPendingNotesPrompt = isLoaded && hasPendingNotes && !hasDismissedBatchNote;
  const formattedPendingNotesUsdTotal = useMemo(
    () => formatUsd(getPendingNotesUsdTotal(claimableNotes ?? [], tokenPrices)),
    [claimableNotes, tokenPrices]
  );

  const hasBalance = useMemo(() => balances.some(token => token.balance > 0), [balances]);
  const faucetStatus = storage.prompts[WalletPromptType.Faucet];
  const faucetIsTerminal =
    faucetStatus === WalletPromptStatus.Dismissed || faucetStatus === WalletPromptStatus.Completed;
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

        setBridgeTransactions(active.map(tx => tx.id));
        await pollActiveBridgePrompts(active);
        if (cancelled) return;
        const refreshed = await fetchActiveBridgePrompts(account.publicKey);
        if (cancelled) return;
        setBridgeTransactions(refreshed.map(tx => tx.id));
        if (refreshed.length === 0) {
          completePrompt(WalletPromptType.Bridge);
          return;
        }
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
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopyStatusIndicator('success');
        if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
        copyTimerRef.current = setTimeout(() => setCopyStatusIndicator('idle'), 1500);
      })
      .catch(error => {
        console.error('[wallet-prompts] failed to copy hot-key error:', error);
        setCopyStatusIndicator('failure');
      });
  }, [hotKeyError]);

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
      setPromptStatus(WalletPromptType.Faucet, WalletPromptStatus.Pending);
    } else if (
      hasBalance &&
      faucetStatus === WalletPromptStatus.Pending &&
      // Let the Funding → Funded! sequence own completion for our own request.
      !awaitingFaucetFunds &&
      !faucetFundsArrived
    ) {
      completePrompt(WalletPromptType.Faucet);
    }
  }, [
    awaitingFaucetFunds,
    balancesLoading,
    completePrompt,
    faucetFundsArrived,
    faucetStatus,
    hasBalance,
    isLoaded,
    setPromptStatus
  ]);

  // An account switch re-renders this component in place (it is not keyed by
  // account) — drop any other account's on-screen funding presentation. Its
  // persisted marker is left untouched, so switching back resumes it via the
  // resume effect below.
  useEffect(() => {
    setFundingWait(current => (current !== null && current.address !== account.publicKey ? null : current));
    setFaucetFundsArrived(false);
    setFaucetStatusIndicator('idle');
    setFaucetError(null);
  }, [account.publicKey]);

  // Re-attach to a request still running at module scope after a remount
  // (HomePrompts unmounts on any navigation): show the loading state again and
  // paint the failure if it rejects. Success needs no handler here — the
  // persisted marker plus the arrival effect own that path.
  useEffect(() => {
    const address = account.publicKey;
    const inFlight = getInFlightFaucetRequest(address);
    if (!inFlight) return;
    let cancelled = false;
    setFaucetStatusIndicator('loading');
    inFlight.then(
      () => {
        if (!cancelled && accountKeyRef.current === address) setFaucetStatusIndicator('idle');
      },
      (error: unknown) => {
        if (cancelled || accountKeyRef.current !== address) return;
        setFundingWait(current => (current !== null && current.address === address ? null : current));
        setFaucetStatusIndicator('failure');
        setFaucetError(error instanceof Error ? error.message : String(error));
      }
    );
    return () => {
      cancelled = true;
    };
  }, [account.publicKey]);

  const fundWallet = useCallback(async () => {
    const address = account.publicKey;
    // A second tap (or a tap from a remount) joins the request already running
    // at module scope instead of starting a second real mint.
    if (getInFlightFaucetRequest(address)) return;
    // Don't arm a wait against an unloaded note set: claimableNotes is SWR
    // data and undefined until its first load resolves, so a baseline
    // snapshotted now would treat every pre-existing note as the arriving
    // mint the moment the load lands.
    if (claimableNotes === undefined) return;
    // Snapshot the notes that already exist: only a note beyond this baseline
    // (or a balance) counts as the mint landing.
    const baselineNoteIds = pendingNoteIds;
    // Anchor the wait to when the user asked, not when the faucet acked — the
    // ack can lag up to the 60s timeout, and the 3-minute backstop is
    // described as "after the original request".
    const requestedAt = Date.now();
    const marker: FaucetFundingMarker = { requestedAt, baselineNoteIds };
    setFaucetStatusIndicator('loading');
    setFaucetError(null);
    // Persist BEFORE the request: the card unmounts on any navigation, and a
    // marker that only exists after the ack would greet a returning user with
    // an idle, fully tappable card while the first request is still running.
    try {
      await setFaucetFundingMarker(address, marker);
    } catch (error) {
      console.warn('[wallet-prompts] failed to persist faucet funding marker:', error);
    }
    setFundingWait({ address, ...marker });
    try {
      await faucet(address);
      if (accountKeyRef.current === address) setFaucetStatusIndicator('idle');
    } catch (error) {
      // The request failed — the pre-persisted marker no longer describes an
      // expected mint, so clear it for WHATEVER account made the request…
      setFaucetFundingMarker(address, null).catch(clearError =>
        console.warn('[wallet-prompts] failed to clear faucet funding marker:', clearError)
      );
      // …but only paint the failure if that account is still on screen.
      if (accountKeyRef.current === address) {
        setFundingWait(current => (current !== null && current.address === address ? null : current));
        setFaucetStatusIndicator('failure');
        setFaucetError(error instanceof Error ? error.message : String(error));
      }
      console.error('[wallet-prompts] faucet request failed:', error);
    }
  }, [account.publicKey, claimableNotes, pendingNoteIds]);

  // Resume the "Funding" wait after a remount, app restart, or switch back to
  // this account: a persisted, still-fresh request marker means the mint is in
  // flight (or already landed, in which case the arrival effect below fires
  // immediately).
  useEffect(() => {
    if (!isLoaded || balancesLoading || awaitingFaucetFunds || faucetFundsArrived || faucetIsTerminal) return;
    const address = account.publicKey;
    let cancelled = false;
    fetchFaucetFundingMarker(address)
      .then(marker => {
        if (cancelled || marker === null) return;
        if (Date.now() - marker.requestedAt < FAUCET_FUNDS_ARRIVAL_TIMEOUT_MS) {
          setFundingWait({ address, ...marker });
        } else {
          void setFaucetFundingMarker(address, null);
        }
      })
      .catch(error => {
        console.warn('[wallet-prompts] failed to read faucet funding marker:', error);
      });
    return () => {
      cancelled = true;
    };
  }, [account.publicKey, awaitingFaucetFunds, balancesLoading, faucetFundsArrived, faucetIsTerminal, isLoaded]);

  // Funds arrived — a NEW claimable note from the native MIDEN faucet (the
  // request only ever mints native), or a balance (the card only exists on a
  // zero-balance account, so any balance is new): swap the "Funding" hero for
  // a short "Funded!" success beat. Requiring the native faucet keeps an
  // unrelated inbound note — or a pre-existing note whose metadata resolved
  // late and only just joined claimableNotes — from faking the success.
  useEffect(() => {
    if (!awaitingFaucetFunds || fundingWait === null) return;
    // An unloaded note set can't be graded against the baseline.
    if (claimableNotes === undefined) return;
    const baseline = new Set(fundingWait.baselineNoteIds);
    const hasNewNote =
      midenFaucetId !== null && claimableNotes.some(note => note.faucetId === midenFaucetId && !baseline.has(note.id));
    if (!hasNewNote && !hasBalance) return;
    setFundingWait(null);
    setFaucetFundsArrived(true);
    setFaucetFundingMarker(fundingWait.address, null).catch(error =>
      console.warn('[wallet-prompts] failed to clear faucet funding marker:', error)
    );
  }, [awaitingFaucetFunds, claimableNotes, fundingWait, hasBalance, midenFaucetId]);

  // After the success beat, complete the prompt so the pending-notes card /
  // balance takes over.
  useEffect(() => {
    if (!faucetFundsArrived) return;
    const timer = setTimeout(() => {
      setFaucetFundsArrived(false);
      completePrompt(WalletPromptType.Faucet);
    }, FAUCET_FUNDED_BEAT_MS);
    return () => clearTimeout(timer);
  }, [completePrompt, faucetFundsArrived]);

  // Backstop: if the funds never show up (faucet acked but the mint failed),
  // fall back to the actionable card instead of spinning forever. Anchored to
  // the request time — not this mount — so a resumed wait still ends 3
  // minutes after the original request.
  useEffect(() => {
    if (!awaitingFaucetFunds || fundingWait === null) return;
    const address = fundingWait.address;
    const remainingMs = Math.max(0, fundingWait.requestedAt + FAUCET_FUNDS_ARRIVAL_TIMEOUT_MS - Date.now());
    const timer = setTimeout(() => {
      setFundingWait(null);
      void setFaucetFundingMarker(address, null);
    }, remainingMs);
    return () => clearTimeout(timer);
  }, [awaitingFaucetFunds, fundingWait]);

  // While the faucet hero is on stage (Funding wait or the Funded! beat), the
  // pending-notes card must NOT surface: it sorts first in the carousel and
  // would shove the hero off-screen the instant the minted note lands, hiding
  // the success beat. It takes over right after the beat completes.
  const faucetHeroActive = awaitingFaucetFunds || faucetFundsArrived || faucetStatusIndicator === 'loading';

  const pendingWalletPrompts = useMemo(() => {
    if (!isLoaded || balancesLoading) return [];
    return WALLET_PROMPT_ORDER.filter(type => {
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
    showFaucetPrompt,
    showPendingNotesPrompt
  ]);

  // Per-type runtime behavior in one place; anything not set here falls back
  // to the static definition (route click, plain body, default dismiss).
  const promptOverrides = useCallback(
    (type: WalletPromptType): PromptCardOverrides => {
      switch (type) {
        case WalletPromptType.Faucet: {
          const funding = awaitingFaucetFunds || faucetStatusIndicator === 'loading';
          return {
            // The whole card is the trigger; no CTA button. While the hero is
            // up (Funding / Funded!) taps are inert.
            onClick: funding || faucetFundsArrived ? undefined : fundWallet,
            status: funding ? 'loading' : faucetFundsArrived ? 'success' : faucetStatusIndicator,
            // On failure the body carries the faucet's actual message, so a
            // rate limit, a rejected amount, and an outage read differently.
            body: faucetStatusIndicator === 'failure' && faucetError ? faucetError : undefined,
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
                    subLabel: hasPendingNotes
                      ? t('faucetPromptFundedSub', { amount: formattedPendingNotesUsdTotal })
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
            onClick: () => navigate('/pending-notes'),
            body: t(WALLET_PROMPT_DEFINITIONS[type].bodyKey, { amount: formattedPendingNotesUsdTotal }),
            onDismiss: () => setPromptStatus(type, WalletPromptStatus.Dismissed, pendingNoteIds)
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
      awaitingFaucetFunds,
      bridgeTransactions,
      copyHotKeyError,
      copyStatusIndicator,
      faucetError,
      faucetFundsArrived,
      faucetStatusIndicator,
      formattedPendingNotesUsdTotal,
      fundWallet,
      hasPendingNotes,
      pendingNoteIds,
      rotateHotKey,
      rotationStatusIndicator,
      setPromptStatus,
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
            title={overrides.title ?? t(definition.titleKey)}
            body={overrides.body ?? t(definition.bodyKey)}
            variant={definition.variant}
            icon={definition.icon}
            hero={overrides.hero}
            onClick={overrides.onClick ?? (route && !overrides.onAction ? () => navigate(route) : undefined)}
            actionLabel={definition.actionKey ? t(definition.actionKey) : undefined}
            onAction={overrides.onAction}
            actionDisabled={overrides.actionDisabled ?? false}
            status={overrides.status}
            onDismiss={overrides.onDismiss ?? (definition.dismissible ? () => dismissPrompt(type) : undefined)}
          />
        );
      })}
      {account.guardianSyncStatus === 'needs-user-input' && <GuardianNeedsUrlBanner />}
    </PromptCarousel>
  );
};

export default HomePrompts;
