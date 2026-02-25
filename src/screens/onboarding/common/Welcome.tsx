import React from 'react';

import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import { ReactComponent as OnboardingLogo } from 'app/icons/v2/onboarding-logo.svg';
import { Button, ButtonVariant } from 'components/Button';
import { isMobile } from 'lib/platform';

export interface WelcomeScreenProps extends Omit<React.ButtonHTMLAttributes<HTMLDivElement>, 'onSubmit'> {
  onSubmit?: (action: Actions) => void;
}

export type Actions = 'select-wallet-type' | 'select-import-type';

export const WelcomeScreen = ({ onSubmit, ...props }: WelcomeScreenProps) => {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center bg-white max-w-full h-full" data-testid="onboarding-welcome">
      <div className="flex flex-col items-center justify-center pt-[120px]">
        <div className="flex flex-col items-center">
          <OnboardingLogo style={{ width: 120, height: 100 }} />
          <h1 className="text-5xl font-semibold mb-4 font-heading text-heading-gray">Miden Wallet</h1>
        </div>
        <p className="text-xl text-heading-gray/75 text-center leading-relaxed font-semibold">
          {t('privateTransactions')}
          <br />
          {t('anytime')}
          <br />
          {t('anywhere')}
        </p>
      </div>
      <div className={clsx('w-full flex flex-col gap-3 px-4 mt-auto pb-8 pt-10', isMobile() ? 'pt-[120px]' : '')}>
        <Button tabIndex={0} title={t('createANewWallet')} onClick={() => onSubmit?.('select-wallet-type')} />
        <Button
          id={'import-link'}
          title={t('iAlreadyHaveAWallet')}
          variant={ButtonVariant.Ghost}
          onClick={() => onSubmit?.('select-import-type')}
        />
      </div>
    </div>
  );
};
