import React, { FC, useCallback, useEffect, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import SimplePageLayout from 'app/layouts/SimplePageLayout';
import LogoVerticalTitle from 'app/misc/logo-vertical-title.svg';
import { Button, ButtonVariant } from 'components/Button';
import { BiometricAvailability, checkBiometricAvailability, unlockWithBiometric } from 'lib/biometric';

export interface BiometricUnlockProps {
  onSuccess: (password: string) => void;
  onFallbackToPassword: () => void;
}

export const BiometricUnlock: FC<BiometricUnlockProps> = ({ onSuccess, onFallbackToPassword }) => {
  const { t } = useTranslation();
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [biometricType, setBiometricType] = useState<BiometricAvailability['biometryType']>('none');

  // Get biometric type label for display
  const getBiometricLabel = useCallback(() => {
    switch (biometricType) {
      case 'face':
        return t('faceId');
      case 'fingerprint':
        return t('fingerprint');
      case 'iris':
        return t('fingerprint'); // Use fingerprint label for iris
      case 'multiple':
        return t('biometricUnlock');
      default:
        return t('biometricUnlock');
    }
  }, [biometricType, t]);

  // Check biometric availability on mount
  useEffect(() => {
    const checkAvailability = async () => {
      const availability = await checkBiometricAvailability();
      setBiometricType(availability.biometryType);
    };
    checkAvailability();
  }, []);

  // Attempt biometric unlock
  const attemptBiometricUnlock = useCallback(async () => {
    setIsAuthenticating(true);
    setError(null);

    try {
      const password = await unlockWithBiometric(t('unlockWithBiometric'));

      if (password) {
        onSuccess(password);
      } else {
        setError(t('biometricFailed'));
      }
    } catch (err: any) {
      setError(err.message || t('biometricFailed'));
    } finally {
      setIsAuthenticating(false);
    }
  }, [onSuccess, t]);

  // Auto-trigger biometric on mount
  useEffect(() => {
    // Small delay to ensure the UI is rendered before triggering biometric
    const timer = setTimeout(() => {
      attemptBiometricUnlock();
    }, 500);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <SimplePageLayout
      icon={
        <>
          <img alt="Miden Wallet Logo" src={`${LogoVerticalTitle}`} />
        </>
      }
    >
      <div className="flex flex-col items-center justify-center grow px-8 py-8">
        {/* Biometric Icon */}
        <div
          className={classNames(
            'w-24 h-24 rounded-full bg-grey-50 flex items-center justify-center mb-8',
            isAuthenticating && 'animate-pulse'
          )}
        >
          <Icon name={IconName.FaceId} size="xl" className="text-primary-500" />
        </div>

        {/* Title */}
        <h2 className="text-xl font-semibold text-center mb-2">{getBiometricLabel()}</h2>

        {/* Subtitle/Status */}
        <p className="text-sm text-grey-600 text-center mb-8">
          {isAuthenticating ? t('biometricAuthRequired') : error || t('unlockWithBiometric')}
        </p>

        {/* Error display */}
        {error && <p className="text-sm text-red-500 text-center mb-4">{error}</p>}

        {/* Try Again Button */}
        <Button
          title={isAuthenticating ? t('processing') : t('tryAgain')}
          onClick={attemptBiometricUnlock}
          disabled={isAuthenticating}
          isLoading={isAuthenticating}
          className="w-full max-w-xs mb-4"
        />

        {/* Fallback to Password */}
        <Button
          title={t('usePasswordInstead')}
          variant={ButtonVariant.Ghost}
          onClick={onFallbackToPassword}
          disabled={isAuthenticating}
          className="w-full max-w-xs"
        />
      </div>
    </SimplePageLayout>
  );
};

export default BiometricUnlock;
