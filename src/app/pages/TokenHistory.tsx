import React, { FC, useRef } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { useAppEnv } from 'app/env';
import History from 'app/templates/history/History';
import { Button, ButtonVariant } from 'components/Button';
import { NavigationHeader } from 'components/NavigationHeader';
import { useAccount, useAllBalances, useAllTokensBaseMetadata } from 'lib/miden/front';
import { isMobile } from 'lib/platform';
import { goBack } from 'lib/woozie';

type TokenHistoryProps = {
  tokenId: string;
};

const TokenHistory: FC<TokenHistoryProps> = ({ tokenId }) => {
  const { t } = useTranslation();
  const { fullPage } = useAppEnv();
  const account = useAccount();
  const scrollParentRef = useRef<HTMLDivElement>(null);
  const allTokensMetadata = useAllTokensBaseMetadata();
  const { data: balances } = useAllBalances(account.publicKey, allTokensMetadata);

  // Get token name from balances (which has metadata embedded) or fall back to metadata store
  const tokenFromBalances = balances?.find(b => b.tokenId === tokenId);
  const tokenName = tokenFromBalances?.metadata?.symbol || allTokensMetadata[tokenId]?.symbol || t('unknown');

  const handleClose = () => goBack();

  // Match SendManager's container sizing - use h-full to inherit from parent (body has safe area padding)
  const containerClass = isMobile()
    ? 'h-full w-full'
    : fullPage
      ? 'h-[640px] max-h-[640px] w-[600px] max-w-[600px] border rounded-3xl'
      : 'h-[600px] max-h-[600px] w-[360px] max-w-[360px]';

  return (
    <div className={classNames(containerClass, 'mx-auto overflow-hidden flex flex-col bg-app-bg')}>
      <NavigationHeader title={t('tokenHistory', { tokenName })} onBack={handleClose} showBorder />
      <div className="flex flex-col flex-1 p-4 justify-between md:w-[460px] md:mx-auto min-h-0">
        <div className={classNames('flex-1 min-h-0 overflow-y-auto', 'bg-app-bg z-30 relative')} ref={scrollParentRef}>
          <History address={account.publicKey} tokenId={tokenId} fullHistory={true} scrollParentRef={scrollParentRef} />
        </div>
        <Button title={t('close')} variant={ButtonVariant.Secondary} onClick={handleClose} />
      </div>
    </div>
  );
};

export default TokenHistory;
