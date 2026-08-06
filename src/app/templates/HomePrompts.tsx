import React, { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
import { GuardianNeedsUrlBanner } from 'app/templates/GuardianNeedsUrlBanner';
import { PromptCard, PromptCardHero, PromptCardStatus, PromptCarousel, PromptCardVariant } from 'components/ui';
import { formatUsd } from 'lib/i18n/numbers';
import type { TokenBalanceData } from 'lib/miden/front';
import type { TokenPrices } from 'lib/prices';
import { WalletAccount } from 'lib/shared/types';
import {
  fetchActiveBridgePrompts,
  faucet,
  fetchFaucetFundingRequestedAt,
  fetchHotKeyHardwareError,
  getPendingNotesUsdTotal,
  type PendingNoteValue,
  pollActiveBridgePrompts,
  setFaucetFundingRequestedAt,
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
  }
};

// How long after a successful faucet request we keep showing the "Funding"
// hero before giving the user the Fund action back. Arrival normally takes
// ~30-60s (chain inclusion + client sync).
const FAUCET_FUNDS_ARRIVAL_TIMEOUT_MS = 3 * 60_000;
// How long the "Funds deposited" success beat holds before the prompt
// completes — long enough to read the two-line lockup.
const FAUCET_FUNDED_BEAT_MS = 2400;

const WALLET_PROMPT_ORDER = [
  WalletPromptType.PendingNotes,
  WalletPromptType.Bridge,
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
  // True between a successful faucet request and the minted funds becoming
  // visible (a claimable note or a balance). The faucet API acks in ~1s but
  // the note takes ~30-60s of chain inclusion + sync to appear; without this
  // the card vanished on ack and the wallet looked idle for that whole gap.
  const [awaitingFaucetFunds, setAwaitingFaucetFunds] = useState(false);
  // Brief "Funded!" success beat once the funds land, before the prompt
  // completes and the card hands off.
  const [faucetFundsArrived, setFaucetFundsArrived] = useState(false);
  const fundingRef = useRef(false);

  const [hotKeyError, setHotKeyError] = useState<string | null>(null);
  const [copyStatusIndicator, setCopyStatusIndicator] = useState<PromptCardStatus>('idle');
  const copyTimerRef = useRef<ReturnType<typeof setTimeout>>();
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

  const fundWallet = useCallback(async () => {
    if (fundingRef.current) return;
    fundingRef.current = true;
    setFaucetStatusIndicator('loading');
    try {
      await faucet(account.publicKey);
      // The request was accepted but the funds aren't visible yet — hold the
      // "Funding" hero until they arrive. Persist the marker so the wait
      // survives a remount or app restart.
      setFaucetStatusIndicator('idle');
      setAwaitingFaucetFunds(true);
      setFaucetFundingRequestedAt(Date.now()).catch(error =>
        console.warn('[wallet-prompts] failed to persist faucet funding marker:', error)
      );
    } catch (error) {
      setFaucetStatusIndicator('failure');
      console.error('[wallet-prompts] faucet request failed:', error);
    } finally {
      fundingRef.current = false;
    }
  }, [account.publicKey]);

  // Resume the "Funding" wait after a remount or app restart: a persisted,
  // still-fresh request marker means the mint is in flight (or already landed,
  // in which case the arrival effect below fires immediately).
  useEffect(() => {
    if (!isLoaded || balancesLoading || awaitingFaucetFunds || faucetFundsArrived || faucetIsTerminal) return;
    let cancelled = false;
    fetchFaucetFundingRequestedAt()
      .then(requestedAt => {
        if (cancelled || requestedAt === null) return;
        if (Date.now() - requestedAt < FAUCET_FUNDS_ARRIVAL_TIMEOUT_MS) {
          setAwaitingFaucetFunds(true);
        } else {
          void setFaucetFundingRequestedAt(null);
        }
      })
      .catch(error => {
        console.warn('[wallet-prompts] failed to read faucet funding marker:', error);
      });
    return () => {
      cancelled = true;
    };
  }, [awaitingFaucetFunds, balancesLoading, faucetFundsArrived, faucetIsTerminal, isLoaded]);

  // Funds arrived (as a claimable note or directly as balance): swap the
  // "Funding" hero for a short "Funded!" success beat.
  useEffect(() => {
    if (!awaitingFaucetFunds || !(hasPendingNotes || hasBalance)) return;
    setAwaitingFaucetFunds(false);
    setFaucetFundsArrived(true);
    void setFaucetFundingRequestedAt(null);
  }, [awaitingFaucetFunds, hasBalance, hasPendingNotes]);

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
  // fall back to the actionable card instead of spinning forever.
  useEffect(() => {
    if (!awaitingFaucetFunds) return;
    const timer = setTimeout(() => {
      setAwaitingFaucetFunds(false);
      void setFaucetFundingRequestedAt(null);
    }, FAUCET_FUNDS_ARRIVAL_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [awaitingFaucetFunds]);

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
        default:
          return {};
      }
    },
    [
      awaitingFaucetFunds,
      bridgeTransactions,
      copyHotKeyError,
      copyStatusIndicator,
      faucetFundsArrived,
      faucetStatusIndicator,
      formattedPendingNotesUsdTotal,
      fundWallet,
      hasPendingNotes,
      pendingNoteIds,
      setPromptStatus,
      t
    ]
  );

  return (
    <PromptCarousel>
      {pendingWalletPrompts.map(([type, definition]) => {
        const overrides = promptOverrides(type);
        const route = definition.route;
        return (
          <PromptCard
            key={type}
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
