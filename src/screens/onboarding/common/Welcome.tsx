import React, { useRef } from 'react';

import { useTranslation } from 'react-i18next';

import { ReactComponent as BreadLogo } from 'app/icons/brand/new-bread.svg';
import { Button, ButtonVariant } from 'components/Button';
import { SubPageLayout } from 'components/ui/SubPageLayout';
import { hapticLight, hapticMedium } from 'lib/mobile/haptics';
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
    <SubPageLayout
      data-testid="onboarding-welcome"
      footerLayout="stack"
      footer={
        <>
          <Button
            tabIndex={0}
            className="max-w-none"
            data-testid="onboarding-get-started"
            title={t('getStarted')}
            onClick={() => onSubmit?.('select-wallet-type')}
          />
          {/* The second way in, as the secondary action under the primary one (Button brings the haptic). */}
          <Button
            id="import-link"
            className="max-w-none"
            variant={ButtonVariant.Secondary}
            data-testid="onboarding-recover-account"
            title={t('recoverYourAccount')}
            onClick={() => onSubmit?.('select-import-type')}
          />
        </>
      }
    >
      <div className="my-auto flex flex-col items-center py-8 text-center">
        <div
          data-testid="onboarding-bread-logo"
          onClick={handleLogoTap}
          className="cursor-default select-none [-webkit-touch-callout:none]"
        >
          <BreadLogo className="h-auto w-[140px]" />
        </div>
        <h1 className="mt-6 font-heading text-[min(56px,15vw)] leading-[1.07] font-extrabold tracking-[-0.5px] [overflow-wrap:anywhere] text-ink">
          <span className="block">{t('welcome')}</span>
          <span className="block">
            {t('toLowercase')} {t('midenWallet')}
          </span>
        </h1>
        <p className="mt-3 max-w-80 font-heading text-base leading-6 font-semibold text-muted">
          {t('breadWalletDescription')}
        </p>
      </div>
    </SubPageLayout>
  );
};
