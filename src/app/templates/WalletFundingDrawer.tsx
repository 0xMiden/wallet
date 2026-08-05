import React, { FC, useEffect } from 'react';

import { useTranslation } from 'react-i18next';

import { useAppEnv } from 'app/env';
import { Icon, IconName } from 'app/icons/v2';
import { Button } from 'components/Button';
import { Loader } from 'components/Loader';
import { Drawer, DrawerContent, DrawerFooter, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';
import { closeWalletFunding, retryWalletFunding, startWalletFunding, useWalletFunding } from 'lib/wallet-funding';

export const WalletFundingDrawer: FC = () => {
  const { t } = useTranslation();
  const { registerBackHandler } = useAppEnv();
  const { open, status, error } = useWalletFunding();
  const isLoading = status === 'idle' || status === 'loading';

  useEffect(() => {
    void startWalletFunding();
  }, []);

  useEffect(() => registerBackHandler(closeWalletFunding), [registerBackHandler]);

  const title = isLoading
    ? t('walletFundingLoadingTitle')
    : status === 'success'
      ? t('walletFundingSuccessTitle')
      : t('walletFundingFailureTitle');
  const description = isLoading
    ? t('walletFundingLoadingBody')
    : status === 'success'
      ? t('walletFundingSuccessBody')
      : t('walletFundingFailureBody');

  return (
    <Drawer open={open} onOpenChange={nextOpen => !nextOpen && closeWalletFunding()}>
      <DrawerContent className="pb-6">
        <DrawerHeader>
          <DrawerTitle>{t('faucetPromptTitle')}</DrawerTitle>
        </DrawerHeader>

        <div className="flex flex-col items-center px-6 pt-2 pb-4 text-center" aria-live="polite">
          <div
            className={`mb-4 flex h-14 w-14 items-center justify-center rounded-full ${
              isLoading
                ? 'bg-primary-50 text-primary-500'
                : status === 'success'
                  ? 'bg-status-positive/15 text-status-positive'
                  : 'bg-status-negative/15 text-status-negative'
            }`}
          >
            {isLoading ? (
              <Loader size="lg" />
            ) : status === 'success' ? (
              <Icon name={IconName.Checkmark} size="md" fill="currentColor" />
            ) : (
              <Icon name={IconName.Close} size="md" fill="currentColor" />
            )}
          </div>
          <h3 className="font-heading text-lg font-bold text-heading-gray">{title}</h3>
          <p className="mt-2 max-w-sm text-sm text-text-muted">{description}</p>

          {status === 'failure' && error && (
            <div
              role="alert"
              className="mt-4 w-full rounded-lg bg-status-negative/10 p-3 text-left text-xs text-status-negative break-words"
            >
              {error}
            </div>
          )}
        </div>

        {status === 'failure' && (
          <DrawerFooter className="items-center justify-center">
            <Button title={t('tryAgain')} onClick={() => void retryWalletFunding()} />
          </DrawerFooter>
        )}
        {status === 'success' && (
          <DrawerFooter className="items-center justify-center">
            <Button title={t('done')} onClick={closeWalletFunding} />
          </DrawerFooter>
        )}
      </DrawerContent>
    </Drawer>
  );
};

export default WalletFundingDrawer;
