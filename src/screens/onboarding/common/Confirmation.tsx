import React from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { Message } from 'components/Message';

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
  const hasError = biometricError && biometricAttempts > 0;

  return (
    <div className="w-full h-full pt-11.5">
      <div {...props} className="flex-1 flex flex-col h-full justify-between bg-app-bg gap-y-8 w-full px-6">
        <div className="flex flex-col items-center grow">
          <Message
            icon={IconName.Success}
            iconSize="3xl"
            iconClassName="mb-8"
            title={t('yourWalletIsReady')}
            description=""
          />
          {hasError && (
            <div className="mt-4 text-center">
              <p className="text-red-500 text-sm mb-2">{t('biometricFailed')}</p>
              {!showPasswordFallback && (
                <p className="text-gray-500 text-xs">
                  {t('biometricAttemptsRemaining', { count: MAX_BIOMETRIC_ATTEMPTS - biometricAttempts })}
                </p>
              )}
            </div>
          )}
        </div>
        <div className="flex flex-col mt-auto items-center gap-y-3 w-full pb-8">
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
              title={hasError ? t('retry') : t('getStarted')}
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
