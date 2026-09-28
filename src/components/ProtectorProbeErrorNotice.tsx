import React from 'react';

import { useTranslation } from 'react-i18next';

import { Notice } from 'components/ui/Notice';

/**
 * The rendering of `useHardwareProtector`'s failure state (#1056) on every screen that shows it
 * on its own: RevealSecret, ExportAccountFile, EncryptedWalletFileWalletPassword and
 * VerifySeedPhraseFlow. The hook probes once per mount and none of these screens offer Retry, so
 * reopening the page is the only remedy, and this notice says exactly that.
 *
 * RotateGuardianReview shows the same `couldNotCheckUnlockMethodReopen` text too, but not
 * through this component: its footer error line folds the probe failure in beside its other
 * errors, so it renders its own `Notice` instead.
 */
export const ProtectorProbeErrorNotice: React.FC<{ className?: string }> = ({ className }) => {
  const { t } = useTranslation();

  return (
    <Notice tone="negative" role="alert" title={t('error')} className={className} data-testid="protector-probe-error">
      {t('couldNotCheckUnlockMethodReopen')}
    </Notice>
  );
};
