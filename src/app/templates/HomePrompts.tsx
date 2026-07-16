import React, { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { ActivateHotKeyBanner } from 'app/templates/ActivateHotKeyBanner';
import { PromptCard, PromptCardStatus, PromptCarousel, PromptCardVariant } from 'components/ui';
import type { TokenBalanceData } from 'lib/miden/front';
import { WalletAccount } from 'lib/shared/types';
import {
  faucet,
  fetchHotKeyHardwareError,
  useWalletPromptStorage,
  WalletPromptStatus,
  WalletPromptType
} from 'lib/wallet-prompts';
import { navigate } from 'lib/woozie';

type WalletPromptDefinition = {
  titleKey: string;
  bodyKey: string;
  route?: string;
  actionKey?: string;
  variant?: PromptCardVariant;
  dismissible: boolean;
};

const WALLET_PROMPT_DEFINITIONS: Record<WalletPromptType, WalletPromptDefinition> = {
  [WalletPromptType.Faucet]: {
    titleKey: 'faucetPromptTitle',
    bodyKey: 'faucetPromptBody',
    actionKey: 'faucetPromptAction',
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
  WalletPromptType.HotKeyHardwareUnavailable,
  WalletPromptType.Faucet,
  WalletPromptType.VerifySeedPhrase
] as const;

interface HomePromptsProps {
  account: WalletAccount;
  balances: TokenBalanceData[];
  balancesLoading: boolean;
}

export const HomePrompts: FC<HomePromptsProps> = ({ account, balances, balancesLoading }) => {
  const { t } = useTranslation();
  const { storage, isLoaded, setPromptStatus, dismissPrompt, completePrompt, isPromptPending } =
    useWalletPromptStorage();
  const [faucetStatusIndicator, setFaucetStatusIndicator] = useState<PromptCardStatus>('idle');
  const fundingRef = useRef(false);
  const successTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const [hotKeyError, setHotKeyError] = useState<string | null>(null);
  const [copyStatusIndicator, setCopyStatusIndicator] = useState<PromptCardStatus>('idle');
  const copyTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const hotKeyPromptPending = isPromptPending(WalletPromptType.HotKeyHardwareUnavailable);

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
    return WALLET_PROMPT_ORDER.filter(type =>
      type === WalletPromptType.Faucet ? showFaucetPrompt : isPromptPending(type)
    ).map(type => [type, WALLET_PROMPT_DEFINITIONS[type]] as [WalletPromptType, WalletPromptDefinition]);
  }, [balancesLoading, isLoaded, isPromptPending, showFaucetPrompt]);

  return (
    <PromptCarousel>
      {pendingWalletPrompts.map(([type, definition]) => {
        const isFaucet = type === WalletPromptType.Faucet;
        const isHotKeyError = type === WalletPromptType.HotKeyHardwareUnavailable;
        const onAction = isFaucet ? fundWallet : isHotKeyError ? copyHotKeyError : undefined;
        const status = isFaucet ? faucetStatusIndicator : isHotKeyError ? copyStatusIndicator : undefined;
        const route = definition.route;
        const onClick = isFaucet || isHotKeyError || !route ? undefined : () => navigate(route);
        return (
          <PromptCard
            key={type}
            title={t(definition.titleKey)}
            body={t(definition.bodyKey)}
            variant={definition.variant}
            onClick={onClick}
            actionLabel={definition.actionKey ? t(definition.actionKey) : undefined}
            onAction={onAction}
            actionDisabled={isFaucet && faucetStatusIndicator === 'loading'}
            status={status}
            onDismiss={definition.dismissible ? () => dismissPrompt(type) : undefined}
          />
        );
      })}
      {account.requiresHotKeyRotation && <ActivateHotKeyBanner />}
    </PromptCarousel>
  );
};

export default HomePrompts;
