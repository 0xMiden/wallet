import React from 'react';

import { useTranslation } from 'react-i18next';

import { ReactComponent as ConfirmationHero } from 'app/icons/onboarding/confirmation-illustrantion.svg';
import { Icon, IconName } from 'app/icons/v2';
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
            <Button tabIndex={0} title={t('continueWithPassword')} onClick={onSwitchToPassword} disabled={isLoading} />
            <Button
              tabIndex={0}
              title={t('tryBiometricAgain')}
              variant={ButtonVariant.Secondary}
              onClick={onSubmit}
              isLoading={isLoading}
              disabled={isLoading}
            />
          </>
        ) : (
          <Button
            tabIndex={0}
            title={primaryButtonTitle}
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
          name={hasFailure ? t('smthWentWrong') : t('yourWalletIsReady')}
          subtitle={
            hasFailure ? undefined : (
              // Held to a readable measure and balanced, so the sentence breaks into two even lines.
              <span className="mx-auto block max-w-[300px] text-balance">{t('recoveryPhraseSevenDayReminder')}</span>
            )
          }
        />
        {/* The daily reminder is a fact about Home, not a warning: one quiet caption line, not a panel. */}
        {!hasFailure && (
          <p
            className="flex max-w-[300px] items-start justify-center gap-1.5 text-caption text-muted"
            data-testid="onboarding-confirmation-reminder"
          >
            <Icon name={IconName.Calendar} size="xs" className="mt-px shrink-0" />
            <span className="text-balance">{t('recoveryPhraseDailyReminder')}</span>
          </p>
        )}

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
