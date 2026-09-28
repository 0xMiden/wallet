import React from 'react';

import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/ui/Button';
import { Notice } from 'components/ui/Notice';

/**
 * The rendering of `useHardwareProtector`'s failure state (#1056, #1241) on every screen that uses the
 * hook: RevealSecret, ExportAccountFile, EncryptedWalletFileWalletPassword, VerifySeedPhraseFlow and
 * RotateGuardianReview's footer. The probe failed or missed its deadline; Retry probes again and stays
 * loading until that attempt settles. RevealSeedPhrase shows the same copy beside its own Retry.
 */
export const ProtectorProbeErrorNotice: React.FC<{ className?: string; onRetry: () => void; retrying: boolean }> = ({
  className,
  onRetry,
  retrying
}) => {
  const { t } = useTranslation();

  return (
    <div className={className}>
      <Notice tone="negative" role="alert" title={t('error')} data-testid="protector-probe-error">
        {t('couldNotCheckUnlockMethod')}
      </Notice>
      <Button
        className="mt-3"
        variant={ButtonVariant.Secondary}
        title={t('retry')}
        onClick={onRetry}
        disabled={retrying}
        isLoading={retrying}
        data-testid="protector-probe-retry"
      />
    </div>
  );
};
