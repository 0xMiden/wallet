import React, { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { ActivateHotKeyBanner } from 'app/templates/ActivateHotKeyBanner';
import { PromptCard, PromptCarousel, PromptCardVariant } from 'components/ui';
import type { TokenBalanceData } from 'lib/miden/front';
import { WalletAccount } from 'lib/shared/types';
import { faucet, useWalletPromptStorage, WalletPromptStatus, WalletPromptType } from 'lib/wallet-prompts';
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
  }
};

const WALLET_PROMPT_ORDER = [WalletPromptType.Faucet, WalletPromptType.VerifySeedPhrase] as const;

interface HomePromptsProps {
  account: WalletAccount;
  balances: TokenBalanceData[];
  balancesLoading: boolean;
}

export const HomePrompts: FC<HomePromptsProps> = ({ account, balances, balancesLoading }) => {
  const { t } = useTranslation();
  const { storage, isLoaded, setPromptStatus, dismissPrompt, completePrompt, isPromptPending } =
    useWalletPromptStorage();
  const [isFunding, setIsFunding] = useState(false);
  const fundingRef = useRef(false);

  const hasBalance = useMemo(() => balances.some(token => token.balance > 0), [balances]);
  const faucetStatus = storage.prompts[WalletPromptType.Faucet];
  const faucetIsTerminal =
    faucetStatus === WalletPromptStatus.Dismissed || faucetStatus === WalletPromptStatus.Completed;
  const showFaucetPrompt = isLoaded && !balancesLoading && !hasBalance && !faucetIsTerminal;

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
    setIsFunding(true);
    try {
      await faucet(account.publicKey);
      completePrompt(WalletPromptType.Faucet);
    } catch (error) {
      console.error('[wallet-prompts] faucet request failed:', error);
    } finally {
      fundingRef.current = false;
      setIsFunding(false);
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
      {pendingWalletPrompts.map(([type, definition]) => (
        <PromptCard
          key={type}
          title={t(definition.titleKey)}
          body={t(definition.bodyKey)}
          variant={definition.variant}
          onClick={type === WalletPromptType.Faucet ? undefined : () => definition.route && navigate(definition.route)}
          actionLabel={definition.actionKey ? t(definition.actionKey) : undefined}
          onAction={type === WalletPromptType.Faucet ? fundWallet : undefined}
          actionDisabled={type === WalletPromptType.Faucet && isFunding}
          onDismiss={definition.dismissible ? () => dismissPrompt(type) : undefined}
        />
      ))}
      {account.requiresHotKeyRotation && <ActivateHotKeyBanner />}
    </PromptCarousel>
  );
};

export default HomePrompts;
