import React, { useRef } from 'react';

import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import { ReactComponent as BreadLogo } from 'app/icons/brand/new-bread.svg';
import { Icon, IconName } from 'app/icons/v2';
import { Button } from 'components/Button';
import { hapticLight, hapticMedium } from 'lib/mobile/haptics';
import { isMobile } from 'lib/platform';
import { navigate } from 'lib/woozie';

export interface WelcomeScreenProps extends Omit<React.ButtonHTMLAttributes<HTMLDivElement>, 'onSubmit'> {
  onSubmit?: (action: Actions) => void;
}

export type Actions = 'select-wallet-type' | 'select-import-type';

export const WelcomeScreen = ({ onSubmit }: WelcomeScreenProps) => {
  const { t } = useTranslation();
  const tapCount = useRef(0);
  const lastTap = useRef(0);

  const handleLogoTap = (e: React.MouseEvent) => {
    e.preventDefault();
    window.getSelection()?.removeAllRanges();
    const now = e.timeStamp;
    tapCount.current = now - lastTap.current > 2000 ? 1 : tapCount.current + 1;
    lastTap.current = now;
    if (tapCount.current >= 4 && tapCount.current < 7) hapticLight();
    if (tapCount.current >= 7) {
      tapCount.current = 0;
      hapticMedium();
      navigate('/developer-settings');
    }
  };

  return (
    <div className="bg-app-bg max-w-full h-full overflow-y-auto" data-testid="onboarding-welcome">
      <div className="min-h-full flex flex-col items-center px-6">
        <div className="flex-1 flex flex-col items-center justify-center w-full py-8">
          <div
            data-testid="onboarding-bread-logo"
            onClick={handleLogoTap}
            className="cursor-default"
            style={{ userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' }}
          >
            <BreadLogo style={{ width: 130, height: 'auto' }} />
          </div>
          <h1 className="text-7xl font-bold font-heading text-heading-gray text-center mt-4 leading-[99%] tracking-tight">
            <span className="block">{t('welcome')}</span>
            <span className="block">
              {t('toLowercase')} <span className="">{t('midenWallet')}</span>
            </span>
          </h1>
          <p className="text-xl leading-[130%] text-heading-gray font-medium text-center mt-4">
            {t('breadWalletDescription')}
          </p>
        </div>
        <div className={clsx('w-full flex flex-col items-center gap-3 pb-6 shrink-0', isMobile() ? 'pt-8' : 'pt-6')}>
          <Button
            tabIndex={0}
            data-testid="onboarding-get-started"
            title={t('getStarted')}
            onClick={() => onSubmit?.('select-wallet-type')}
          />
          <button
            id="import-link"
            data-testid="onboarding-recover-account"
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
