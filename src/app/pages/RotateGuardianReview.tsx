import React, { FC, useCallback, useEffect, useMemo, useState } from 'react';

import { useTranslation } from 'react-i18next';

import {
  guardianEndpointHost,
  guardianOptionForEndpoint,
  useCurrentGuardianEndpoint
} from 'app/hooks/useCurrentGuardianEndpoint';
import { Icon, IconName } from 'app/icons/v2';
import PageLayout from 'app/layouts/PageLayout';
import { Alert, AlertVariant } from 'components/Alert';
import { Button } from 'components/Button';
import { checkBiometricAvailability, isBiometricEnabled } from 'lib/biometric';
import { initiateSwitchGuardianTransaction, requestSWTransactionProcessing } from 'lib/miden/activity';
import { zustandProvider } from 'lib/miden/front/guardian-sync';
import { isExtension } from 'lib/platform';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { useWalletStore } from 'lib/store';
import { DetailCard, DetailRow } from 'lib/ui/DetailCard';
import { navigate, useLocation } from 'lib/woozie';

const RotateGuardianReview: FC = () => {
  const { t } = useTranslation();
  const { search } = useLocation();
  const { endpoint: currentEndpoint } = useCurrentGuardianEndpoint();
  const currentAccount = useWalletStore(s => s.currentAccount);

  const newEndpoint = useMemo(() => new URLSearchParams(search).get('endpoint') ?? '', [search]);

  const currentName = guardianOptionForEndpoint(currentEndpoint)?.name ?? guardianEndpointHost(currentEndpoint);
  const newName = guardianOptionForEndpoint(newEndpoint)?.name ?? guardianEndpointHost(newEndpoint);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The hot key co-signs from the unlocked vault; surface how it's protected
  // on this device (biometric flavor or password) like the design's key rows.
  const [hotKeyLabel, setHotKeyLabel] = useState(() => t('password'));
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!(await isBiometricEnabled())) return;
        const availability = await checkBiometricAvailability();
        if (cancelled) return;
        if (availability.biometryType === 'face') setHotKeyLabel(t('faceId'));
        else if (availability.biometryType !== 'none') setHotKeyLabel(t('fingerprint'));
      } catch {
        // Keep the password fallback.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [t]);

  const handleContinue = useCallback(async () => {
    if (!currentAccount || !newEndpoint || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const txId = await initiateSwitchGuardianTransaction(
        currentAccount.publicKey,
        newEndpoint,
        isDelegateProofEnabled(),
        zustandProvider
      );
      if (isExtension()) requestSWTransactionProcessing();
      navigate(`/generating-transaction-full/${encodeURIComponent(txId)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [currentAccount, newEndpoint, submitting]);

  return (
    <PageLayout pageTitle={<>{t('reviewRotation')}</>}>
      <div className="h-full overflow-y-auto">
        <div className="w-full max-w-sm mx-auto px-4 pb-8 flex flex-col min-h-full">
          <div className="rounded-2xl bg-surface-interactive px-4 py-8 flex flex-col items-center">
            <span className="px-3 py-1 rounded-lg bg-white dark:bg-grey-800 text-sm font-medium text-text-tertiary-token">
              {t('currentLabel')}
            </span>
            <h2 className="mt-3 text-3xl font-semibold font-heading text-heading-gray text-center break-all">
              {currentName || t('loading')}
            </h2>
            <div className="my-5 w-10 h-10 rounded-lg bg-primary-500 flex items-center justify-center">
              <Icon name={IconName.ArrowDown} fill="white" size="sm" />
            </div>
            <span className="px-3 py-1 rounded-lg bg-white dark:bg-grey-800 text-sm font-medium text-text-tertiary-token">
              {t('newLabel')}
            </span>
            <h2 className="mt-3 text-3xl font-semibold font-heading text-heading-gray text-center break-all">
              {newName}
            </h2>
          </div>

          <div className="mt-4">
            <DetailCard>
              <DetailRow label={t('walletKeyHot')} value={hotKeyLabel} />
              <DetailRow label={t('recoveryPhraseCold')} value={t('required')} isLast />
            </DetailCard>
          </div>

          <Alert
            variant={AlertVariant.Warning}
            className="mt-4"
            title={
              <span className="block">
                <span className="block text-sm font-semibold text-heading-gray">{t('oldGuardianCantBlockTitle')}</span>
                <span className="block mt-1">{t('oldGuardianCantBlockBody')}</span>
              </span>
            }
          />

          {error && <div className="mt-3 text-red-500 text-xs select-text">{error}</div>}

          <div className="mt-auto pt-6">
            <Button
              data-testid="rotate-guardian-confirm"
              title={submitting ? t('loading') : t('continue')}
              onClick={handleContinue}
              disabled={submitting || !currentAccount || !newEndpoint}
            />
          </div>
        </div>
      </div>
    </PageLayout>
  );
};

export default RotateGuardianReview;
