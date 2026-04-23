import React, { HTMLAttributes, useCallback } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
import PageLayout from 'app/layouts/PageLayout';
import { Button, ButtonVariant } from 'components/Button';
import { Message } from 'components/Message';
import { getFaucetUrl } from 'lib/miden-chain/faucet';
import { useNetwork } from 'lib/miden/front';
import { openFaucetWebview } from 'lib/mobile/faucet-webview';
import { navigate } from 'lib/woozie';

export interface GetTokensProps extends HTMLAttributes<HTMLDivElement> {}

export const GetTokens: React.FC<GetTokensProps> = ({ className, ...props }) => {
  const { t } = useTranslation();
  const network = useNetwork();

  const onFaucetClick = useCallback(async () => {
    const faucetUrl = getFaucetUrl(network.id);
    await openFaucetWebview({ url: faucetUrl, title: t('midenFaucet') });
  }, [network.id, t]);

  const onTransferClick = useCallback(() => {
    navigate('/receive');
  }, []);

  return (
    <PageLayout
      pageTitle={
        <>
          <span>{t('addTokens')}</span>
        </>
      }
      hasBackAction={true}
    >
      <div {...props} className={classNames('flex-1 flex flex-col', className)}>
        <div className="flex-1 flex flex-col justify-center bg-app-bg p-4 md:w-[460px] md:mx-auto">
          <Message
            className="flex-1"
            title={t('getTokens')}
            description={t('getTokensDescription')}
            icon={IconName.Tokens}
            iconSize="3xl"
            iconClassName="mb-8"
          />
        </div>
        <div className="p-4 flex flex-col gap-y-4">
          <Button title={t('faucet')} onClick={onFaucetClick} />
          <Button title={t('transferTokens')} variant={ButtonVariant.Secondary} onClick={onTransferClick} />
        </div>
      </div>
    </PageLayout>
  );
};
