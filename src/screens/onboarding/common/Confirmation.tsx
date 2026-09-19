import React from 'react';

import { Trans, useTranslation } from 'react-i18next';

import { ReactComponent as ConfirmationHero } from 'app/icons/onboarding/confirmation-illustrantion.svg';
import { Button, ButtonVariant } from 'components/Button';
import { Hero } from 'components/ui/Hero';
import { Notice } from 'components/ui/Notice';
import { Spinner } from 'components/ui/Spinner';
import { SubPageLayout } from 'components/ui/SubPageLayout';

const MAX_BIOMETRIC_ATTEMPTS = 3;

export interface ConfirmationScreenProps {
  'data-testid'?: string;
  isLoading?: boolean;
  biometricAttempts?: number;
  biometricError?: string | null;
  /**
   * A recovery/registration failure to surface on this screen. The wallet reset
   * that precedes registration is DESTRUCTIVE, so a failure here must be visible
   * — previously it was console.error'd and the flow navigated on regardless,
   * leaving the user on a wiped wallet with no explanation (#630).
   */
  recoveryError?: string | null;
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
  isLoading,
  biometricAttempts = 0,
  biometricError,
  recoveryError,
  creating = false,
  onSubmit,
  onSwitchToPassword,
  'data-testid': dataTestId
}) => {
  const { t } = useTranslation();

  const showPasswordFallback = biometricAttempts >= MAX_BIOMETRIC_ATTEMPTS;
  const hasError = !!biometricError && biometricAttempts > 0;
  const hasRecoveryError = !!recoveryError;

  // Side-panel handoff (Chrome): the wallet is still being created in the
  // background. Show a spinner rather than the ready-state success message,
  // otherwise the user sees "Your wallet is ready" before it actually is.
  if (creating) {
    return (
      <div
        data-testid={dataTestId}
        className="flex h-full w-full flex-col items-center justify-center gap-y-4 bg-app-bg px-4 text-center"
      >
        <Spinner />
        <p className="font-sans text-[15px] leading-[22px] text-muted">{t('creatingYourWallet')}</p>
      </div>
    );
  }

  const hasFailure = hasError || hasRecoveryError;
  const primaryButtonTitle = hasFailure ? t('retry') : t('openWallet');

  return (
    <SubPageLayout
      data-testid="onboarding-confirmation"
      footerLayout="stack"
      footer={
        showPasswordFallback ? (
          <>
            <Button
              tabIndex={0}
              title={t('continueWithPassword')}
              className="max-w-none"
              onClick={onSwitchToPassword}
              disabled={isLoading}
            />
            <Button
              tabIndex={0}
              title={t('tryBiometricAgain')}
              variant={ButtonVariant.Secondary}
              className="max-w-none"
              onClick={onSubmit}
              isLoading={isLoading}
              disabled={isLoading}
            />
          </>
        ) : (
          <Button
            tabIndex={0}
            title={primaryButtonTitle}
            className="max-w-none"
            onClick={onSubmit}
            isLoading={isLoading}
            disabled={isLoading}
            data-testid="onboarding-confirmation-submit"
          />
        )
      }
    >
      <div className="my-auto flex flex-col items-center gap-4 py-6 text-center">
        <Hero
          nameAs="h1"
          visual={<ConfirmationHero aria-hidden="true" className="h-auto w-full max-w-[220px]" />}
          name={
            hasFailure ? (
              t('smthWentWrong')
            ) : (
              <Trans
                i18nKey="yourWalletIsReady"
                components={{ highlight: <span className="text-accent-tint-ink" /> }}
              />
            )
          }
          subtitle={hasFailure ? undefined : t('recoveryPhraseSevenDayReminder')}
        />
        {!hasFailure && <Notice className="text-left">{t('recoveryPhraseDailyReminder')}</Notice>}

        {hasFailure && (
          <Notice tone="negative" role="alert" className="text-left">
            <span className="flex flex-col gap-1">
              {hasRecoveryError && (
                <span className="select-text" data-testid="onboarding-recovery-error">
                  {recoveryError}
                </span>
              )}
              {hasError && (
                <>
                  <span>{t('biometricFailed')}</span>
                  {!showPasswordFallback && (
                    <span className="text-muted">
                      {t('biometricAttemptsRemaining', { count: MAX_BIOMETRIC_ATTEMPTS - biometricAttempts })}
                    </span>
                  )}
                </>
              )}
            </span>
          </Notice>
        )}
      </div>
    </SubPageLayout>
  );
};
