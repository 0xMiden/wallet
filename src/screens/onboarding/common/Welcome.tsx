import React from 'react';

import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import { ReactComponent as BreadLogo } from 'app/icons/brand/bread.svg';
import { Icon, IconName } from 'app/icons/v2';
import { Button } from 'components/Button';
import { hapticLight } from 'lib/mobile/haptics';
import { isMobile } from 'lib/platform';

export interface WelcomeScreenProps extends Omit<React.ButtonHTMLAttributes<HTMLDivElement>, 'onSubmit'> {
  onSubmit?: (action: Actions) => void;
}

export type Actions = 'select-wallet-type' | 'select-import-type';

export const WelcomeScreen = ({ onSubmit }: WelcomeScreenProps) => {
  const { t } = useTranslation();
  return (
    <div className="bg-app-bg max-w-full h-full overflow-y-auto" data-testid="onboarding-welcome">
      <div className="min-h-full flex flex-col items-center px-6">
        <div className="flex-1 flex flex-col items-center justify-center w-full py-8">
          <BreadLogo style={{ width: 130, height: 226 }} />
          <h1 className="text-7xl font-semibold font-heading text-heading-gray text-center mt-4 leading-[99%] tracking-tight">
            <span className="block">{t('welcome')}</span>
            <span className="block">
              {t('toLowercase')} <span className="text-primary-500">{t('midenWallet')}</span>
            </span>
          </h1>
          <p className="text-lg leading-[130%] text-heading-gray text-center mt-4">{t('breadWalletDescription')}</p>
        </div>
        <div className={clsx('w-full flex flex-col items-center gap-4 pb-6 shrink-0', isMobile() ? 'pt-8' : 'pt-6')}>
          <Button tabIndex={0} title={t('getStarted')} onClick={() => onSubmit?.('select-wallet-type')} />
          <button
            id="import-link"
            type="button"
            className="flex items-center justify-center gap-1 py-3 text-sm font-medium text-text-tertiary-token"
            onClick={() => {
              hapticLight();
              onSubmit?.('select-import-type');
            }}
          >
            {t('recoverYourAccount')}
            <Icon name={IconName.ChevronRight} size="xs" className="p-0.5" />
          </button>
        </div>
      </div>
    </div>
  );
};
