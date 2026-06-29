import React from 'react';

import { Trans, useTranslation } from 'react-i18next';

import Spinner from 'app/atoms/Spinner/Spinner';
import { ReactComponent as ConfirmationHero } from 'app/icons/onboarding/confirmation-illustrantion.svg';
import { Button, ButtonVariant } from 'components/Button';

const MAX_BIOMETRIC_ATTEMPTS = 3;

export interface ConfirmationScreenProps extends React.ButtonHTMLAttributes<HTMLDivElement> {
  isLoading?: boolean;
  biometricAttempts?: number;
  biometricError?: string | null;
  /**
   * Side panel handoff (Chrome): the wallet is being created in the background
   * before the user opens it. While true, show a spinner instead of the
   * ready-state success message + button.
   */
  creating?: boolean;
  onSubmit?: () => void;
  onSwitchToPassword?: () => void;
}

export const ConfirmationScreen: React.FC<ConfirmationScreenProps> = ({
  className,
  isLoading,
  biometricAttempts = 0,
  biometricError,
  creating = false,
  onSubmit,
  onSwitchToPassword,
  ...props
}) => {
  const { t } = useTranslation();

  const showPasswordFallback = biometricAttempts >= MAX_BIOMETRIC_ATTEMPTS;
  const hasError = !!biometricError && biometricAttempts > 0;

  if (creating) {
    return (
      <div className="w-full h-full pt-11.5">
        <div {...props} className="flex flex-col items-center justify-center h-full gap-y-4 bg-app-bg w-full px-6">
          <Spinner />
          <p className="text-text-muted text-sm">{t('creatingYourWallet')}</p>
        </div>
      </div>
    );
  }

  const primaryButtonTitle = hasError ? t('retry') : t('openWallet');

  return (
    <div {...props} className="bg-app-bg max-w-full h-full overflow-hidden" data-testid="onboarding-confirmation">
      <div className="min-h-full flex flex-col items-center px-6 pb-8">
        <div className="flex-1 flex flex-col items-center justify-center w-full text-center py-8">
          <ConfirmationHero style={{ width: 240, height: 'auto' }} />
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
                <p className="text-text-muted text-xs">
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
              title={primaryButtonTitle}
              className="self-center w-full text-base"
              onClick={onSubmit}
              isLoading={isLoading}
              data-testid="onboarding-confirmation-submit"
            />
          )}
        </div>
      </div>
    </div>
  );
};
