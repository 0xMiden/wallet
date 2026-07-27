import React, { FC, useMemo } from 'react';

import { useTranslation } from 'react-i18next';

import { GuardianNeedsUrlBanner } from 'app/templates/GuardianNeedsUrlBanner';
import { PromptCard, PromptCarousel, PromptCardVariant } from 'components/ui';
import { WalletAccount } from 'lib/shared/types';
import { useWalletPromptStorage, WalletPromptType } from 'lib/wallet-prompts';
import { navigate } from 'lib/woozie';

type WalletPromptDefinition = {
  titleKey: string;
  bodyKey: string;
  route: string;
  variant?: PromptCardVariant;
  dismissible: boolean;
};

const WALLET_PROMPT_DEFINITIONS: Record<WalletPromptType, WalletPromptDefinition> = {
  [WalletPromptType.VerifySeedPhrase]: {
    titleKey: 'verifySeedPhrasePromptTitle',
    bodyKey: 'verifySeedPhrasePromptBody',
    route: '/settings/verify-seed-phrase',
    variant: 'warning',
    dismissible: true
  }
};

interface HomePromptsProps {
  account: WalletAccount;
}

export const HomePrompts: FC<HomePromptsProps> = ({ account }) => {
  const { t } = useTranslation();
  const { dismissPrompt, isPromptPending } = useWalletPromptStorage();

  const pendingWalletPrompts = useMemo(
    () =>
      Object.entries(WALLET_PROMPT_DEFINITIONS).filter(([type]) => isPromptPending(type as WalletPromptType)) as Array<
        [WalletPromptType, WalletPromptDefinition]
      >,
    [isPromptPending]
  );

  return (
    <PromptCarousel>
      {pendingWalletPrompts.map(([type, definition]) => (
        <PromptCard
          key={type}
          title={t(definition.titleKey)}
          body={t(definition.bodyKey)}
          variant={definition.variant}
          onClick={() => navigate(definition.route)}
          onDismiss={definition.dismissible ? () => dismissPrompt(type) : undefined}
        />
      ))}
      {account.guardianSyncStatus === 'needs-user-input' && <GuardianNeedsUrlBanner />}
    </PromptCarousel>
  );
};

export default HomePrompts;
