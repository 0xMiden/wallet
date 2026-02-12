import React, { useCallback, useEffect, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { BiometricAvailability, checkBiometricAvailability, setupBiometric } from 'lib/biometric';
import { isMobile } from 'lib/platform';

export interface BiometricSetupScreenProps {
  password: string;
  onSubmit: (biometricEnabled: boolean) => void;
}

export const BiometricSetupScreen: React.FC<BiometricSetupScreenProps> = ({ password, onSubmit }) => {
  const { t } = useTranslation();
  const [isLoading, setIsLoading] = useState(false);
  const [biometricAvailability, setBiometricAvailability] = useState<BiometricAvailability | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Check biometric availability on mount
  useEffect(() => {
    const checkAvailability = async () => {
      if (!isMobile()) {
        // On non-mobile platforms, skip biometric setup
        onSubmit(false);
        return;
      }

      const availability = await checkBiometricAvailability();
      setBiometricAvailability(availability);

      // If biometric is not available, skip this step
      if (!availability.isAvailable) {
        onSubmit(false);
      }
    };
    checkAvailability();
  }, [onSubmit]);

  // Get biometric type label for display
  const getBiometricLabel = useCallback(() => {
    if (!biometricAvailability) return t('biometricUnlock');

    switch (biometricAvailability.biometryType) {
      case 'face':
        return t('faceId');
      case 'fingerprint':
        return t('fingerprint');
      case 'iris':
        return t('fingerprint');
      case 'multiple':
        return t('biometricUnlock');
      default:
        return t('biometricUnlock');
    }
  }, [biometricAvailability, t]);

  const handleEnableBiometric = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const success = await setupBiometric(password);
      if (success) {
        onSubmit(true);
      } else {
        setError(t('biometricFailed'));
      }
    } catch (err: any) {
      setError(err.message || t('biometricFailed'));
    } finally {
      setIsLoading(false);
    }
  }, [password, onSubmit, t]);

  const handleSkip = useCallback(() => {
    onSubmit(false);
  }, [onSubmit]);

  // If biometric availability hasn't been checked yet, show loading
  if (!biometricAvailability) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-white">
        <Icon name={IconName.Loader} size="xl" className="animate-spin text-primary-500" />
      </div>
    );
  }

  // If biometric is not available, this screen shouldn't render (handled in useEffect)
  if (!biometricAvailability.isAvailable) {
    return null;
  }

  return (
    <div className={classNames('flex-1', 'flex flex-col', 'bg-white gap-y-8 p-6')}>
      <div className="flex flex-col items-center grow justify-center">
        {/* Biometric Icon */}
        <div className="w-32 h-32 rounded-full bg-grey-50 flex items-center justify-center mb-8">
          <Icon name={IconName.FaceId} size="3xl" className="text-primary-500" />
        </div>

        {/* Title */}
        <h1 className="text-2xl font-semibold text-center mb-4">{t('biometricSetup')}</h1>

        {/* Description */}
        <p className="text-sm text-grey-600 text-center max-w-xs mb-2">{t('biometricSetupDescription')}</p>
        <p className="text-sm text-grey-500 text-center max-w-xs">{t('biometricSetupSubtitle')}</p>

        {/* Biometric Type Info */}
        <div className="mt-6 px-4 py-3 bg-grey-50 rounded-lg">
          <p className="text-sm text-grey-600">
            {t('biometricType')}: <span className="font-medium text-black">{getBiometricLabel()}</span>
          </p>
        </div>

        {/* Error display */}
        {error && <p className="text-sm text-red-500 text-center mt-4">{error}</p>}
      </div>

      {/* Action Buttons */}
      <div className="flex flex-col gap-3 w-full max-w-sm mx-auto">
        <Button
          title={isLoading ? t('processing') : t('enableBiometric')}
          onClick={handleEnableBiometric}
          disabled={isLoading}
          isLoading={isLoading}
          className="w-full"
        />
        <Button
          title={t('skipBiometricSetup')}
          variant={ButtonVariant.Ghost}
          onClick={handleSkip}
          disabled={isLoading}
          className="w-full"
        />
      </div>
    </div>
  );
};

export default BiometricSetupScreen;
