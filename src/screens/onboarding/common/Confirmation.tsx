import React from 'react';

import { Trans, useTranslation } from 'react-i18next';

import { ReactComponent as ConfirmationHero } from 'app/icons/onboarding/confirmation.svg';
import { ReactComponent as EllipseBackdropLight } from 'app/icons/onboarding/ellipse-light.svg';
import { ReactComponent as EllipseBackdropDark } from 'app/icons/onboarding/ellipse.svg';
import { Button, ButtonVariant } from 'components/Button';

const MAX_BIOMETRIC_ATTEMPTS = 3;

export interface ConfirmationScreenProps extends React.ButtonHTMLAttributes<HTMLDivElement> {
  isLoading?: boolean;
  biometricAttempts?: number;
  biometricError?: string | null;
  onSubmit?: () => void;
  onSwitchToPassword?: () => void;
}

export const ConfirmationScreen: React.FC<ConfirmationScreenProps> = ({
  className,
  isLoading,
  biometricAttempts = 0,
  biometricError,
  onSubmit,
  onSwitchToPassword,
  ...props
}) => {
  const { t } = useTranslation();

  const showPasswordFallback = biometricAttempts >= MAX_BIOMETRIC_ATTEMPTS;
  const hasError = !!biometricError && biometricAttempts > 0;

  return (
    <div
      {...props}
      className="relative bg-app-bg max-w-full h-full overflow-hidden"
      data-testid="onboarding-confirmation"
    >
      <EllipseBackdropLight
        className="pointer-events-none absolute inset-0 w-full h-full block dark:hidden"
        preserveAspectRatio="xMidYMid slice"
      />
      <EllipseBackdropDark
        className="pointer-events-none absolute inset-0 w-full h-full hidden dark:block"
        preserveAspectRatio="xMidYMid slice"
      />

      <div className="relative z-10 min-h-full flex flex-col items-center px-6 pb-8">
        <div className="flex-1 flex flex-col items-center justify-center w-full text-center py-8">
          <ConfirmationHero className="w-39 h-39" />
          <h1 className="mt-6 text-5xl font-semibold font-heading text-heading-gray leading-[100%] tracking-tight">
            <Trans i18nKey="yourWalletIsReady" components={{ highlight: <span className="text-primary-500" /> }} />
          </h1>
          {/* TODO: Wrap in a single class and then have child components */}
          <p className="mt-3 text-lg text-heading-gray leading-[130%] font-medium">
            {t('recoveryPhraseSevenDayReminder')}
          </p>
          <p className="mt-4 text-lg text-heading-gray leading-[130%]" font-medium>
            {t('recoveryPhraseDailyReminder')}
          </p>

          {hasError && (
            <div className="mt-4">
              <p className="text-red-500 text-sm mb-2">{t('biometricFailed')}</p>
              {!showPasswordFallback && (
                <p className="text-gray-500 text-xs">
                  {t('biometricAttemptsRemaining', { count: MAX_BIOMETRIC_ATTEMPTS - biometricAttempts })}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="w-full flex flex-col items-center gap-y-3 shrink-0">
          {showPasswordFallback ? (
            <>
              <Button
                tabIndex={0}
                title={t('continueWithPassword')}
                className="self-center"
                onClick={onSwitchToPassword}
              />
              <Button
                tabIndex={0}
                title={t('tryBiometricAgain')}
                variant={ButtonVariant.Secondary}
                className="self-center"
                onClick={onSubmit}
                isLoading={isLoading}
              />
            </>
          ) : (
            <Button
              tabIndex={0}
              title={hasError ? t('retry') : t('openWallet')}
              className="self-center w-full text-base"
              onClick={onSubmit}
              isLoading={isLoading}
            />
          )}
        </div>
      </div>
    </div>
  );
};
