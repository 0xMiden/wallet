import React, { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { GuardianNeedsUrlBanner } from 'app/templates/GuardianNeedsUrlBanner';
import { PromptCard, PromptCardStatus, PromptCarousel, PromptCardVariant } from 'components/ui';
import { formatUsd } from 'lib/i18n/numbers';
import type { TokenBalanceData } from 'lib/miden/front';
import type { TokenPrices } from 'lib/prices';
import { WalletAccount } from 'lib/shared/types';
import {
  fetchActiveBridgePrompts,
  faucet,
  fetchHotKeyHardwareError,
  getPendingNotesUsdTotal,
  type PendingNoteValue,
  pollActiveBridgePrompts,
  useWalletPromptStorage,
  WalletPromptStatus,
  WalletPromptType
} from 'lib/wallet-prompts';
import { navigate } from 'lib/woozie';

type PromptCardOverrides = {
  body?: string;
  status?: PromptCardStatus;
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
    actionKey: 'faucetPromptAction',
    dismissible: true
  },
  [WalletPromptType.PendingNotes]: {
    titleKey: 'pendingNotesPromptTitle',
    bodyKey: 'pendingNotesPromptBody',
    actionKey: 'pendingNotesPromptAction',
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
  const fundingRef = useRef(false);
  const successTimerRef = useRef<ReturnType<typeof setTimeout>>();

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
    faucetStatusIndicator === 'success' || (isLoaded && !balancesLoading && !hasBalance && !faucetIsTerminal);

  useEffect(
    () => () => {
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
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
    } else if (hasBalance && faucetStatus === WalletPromptStatus.Pending) {
      completePrompt(WalletPromptType.Faucet);
    }
  }, [balancesLoading, completePrompt, faucetStatus, hasBalance, isLoaded, setPromptStatus]);

  const fundWallet = useCallback(async () => {
    if (fundingRef.current) return;
    fundingRef.current = true;
    setFaucetStatusIndicator('loading');
    try {
      await faucet(account.publicKey);
      setFaucetStatusIndicator('success');
      completePrompt(WalletPromptType.Faucet);
      successTimerRef.current = setTimeout(() => setFaucetStatusIndicator('idle'), 1200);
    } catch (error) {
      setFaucetStatusIndicator('failure');
      console.error('[wallet-prompts] faucet request failed:', error);
    } finally {
      fundingRef.current = false;
    }
  }, [account.publicKey, completePrompt]);

  const pendingWalletPrompts = useMemo(() => {
    if (!isLoaded || balancesLoading) return [];
    return WALLET_PROMPT_ORDER.filter(type => {
      if (type === WalletPromptType.PendingNotes) return showPendingNotesPrompt;
      if (type === WalletPromptType.Faucet) return showFaucetPrompt;
      if (type === WalletPromptType.Bridge) return bridgePromptPending && bridgeTransactions.length > 0;
      return isPromptPending(type);
    }).map<[WalletPromptType, WalletPromptDefinition]>(type => [type, WALLET_PROMPT_DEFINITIONS[type]]);
  }, [
    balancesLoading,
    bridgePromptPending,
    bridgeTransactions.length,
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
        case WalletPromptType.Faucet:
          return {
            onAction: fundWallet,
            status: faucetStatusIndicator,
            actionDisabled: faucetStatusIndicator === 'loading'
          };
        case WalletPromptType.Bridge:
          return {
            onClick: () => navigate(`/history-details/${bridgeTransactions[0]}`),
            status: 'loading'
          };
        case WalletPromptType.PendingNotes:
          return {
            onAction: () => navigate('/pending-notes'),
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
      bridgeTransactions,
      copyHotKeyError,
      copyStatusIndicator,
      faucetStatusIndicator,
      formattedPendingNotesUsdTotal,
      fundWallet,
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
            title={t(definition.titleKey)}
            body={overrides.body ?? t(definition.bodyKey)}
            variant={definition.variant}
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
