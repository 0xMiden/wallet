import React, { useCallback, useEffect, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import RootSuspenseFallback from 'app/a11y/RootSuspenseFallback';
import { Button, ButtonVariant } from 'components/ui/Button';
import { SubPageLayout, SubPageSection } from 'components/ui/SubPageLayout';
import { useMidenContext } from 'lib/miden/front';
import type { StorageRecoveryResult } from 'lib/miden/recovery/types';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { RecoveryDataFlow } from 'screens/storage-recovery/RecoveryDataFlow';

export const StorageRecoveryPage: React.FC<{ onBack?: () => void }> = ({ onBack }) => {
  const { t } = useTranslation();
  const { storageAvailability, ready, recoverWalletStorage } = useMidenContext();
  const [busy, setBusy] = useState(false);
  const [fileMode, setFileMode] = useState<'export' | 'import'>();
  const closeFile = useCallback(() => setFileMode(undefined), []);
  const [result, setResult] = useState<StorageRecoveryResult>();
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);
  const activeAttempt = useRef(false);
  const epoch = storageAvailability?.status === 'unavailable' ? storageAvailability.epoch : undefined;

  useEffect(() => {
    const owner = ++generation.current;
    activeAttempt.current = false;
    setBusy(false);
    setFileMode(undefined);
    setResult(undefined);
    setFailed(false);
    return () => {
      generation.current = owner + 1;
    };
  }, [epoch]);

  useMobileBackHandler(() => {
    if (fileMode || !onBack) return false;
    onBack();
    return true;
  }, [fileMode, onBack]);

  if (epoch === undefined) return <RootSuspenseFallback />;

  if (fileMode) return <RecoveryDataFlow key={epoch} mode={fileMode} onClose={closeFile} />;

  const recover = async (operation: 'check' | 'rebuild' | 'reconcile') => {
    if (activeAttempt.current) return;
    activeAttempt.current = true;
    const owner = generation.current;
    setBusy(true);
    setFailed(false);
    setResult(undefined);
    try {
      const next = await recoverWalletStorage(operation, epoch);
      if (owner === generation.current) setResult(next);
    } catch {
      if (owner === generation.current) setFailed(true);
    } finally {
      if (owner === generation.current) {
        activeAttempt.current = false;
        setBusy(false);
      }
    }
  };

  return (
    <SubPageLayout
      data-testid="storage-recovery-page"
      title={t('storageRecoveryTitle')}
      onBack={onBack}
      focusTitleOnMount
    >
      <SubPageSection description={t('storageRecoveryDescription')}>
        <p className="text-body-sm text-muted">{t('storageRecoverySubmissionWarning')}</p>
      </SubPageSection>
      {ready && (
        <SubPageSection>
          <Button disabled={busy} isLoading={busy} onClick={() => recover('check')}>
            {t('storageRecoveryCheck')}
          </Button>
          <Button variant={ButtonVariant.Secondary} disabled={busy} onClick={() => recover('rebuild')}>
            {t('storageRecoveryRebuild')}
          </Button>
          <Button variant={ButtonVariant.Secondary} disabled={busy} onClick={() => recover('reconcile')}>
            {t('storageRecoveryReconcile')}
          </Button>
        </SubPageSection>
      )}
      <SubPageSection description={t('recoveryDataDescription')}>
        <Button title={t('recoveryDataExport')} disabled={busy} onClick={() => setFileMode('export')} />
        <Button
          variant={ButtonVariant.Secondary}
          title={t('recoveryDataImport')}
          disabled={busy}
          onClick={() => setFileMode('import')}
        />
      </SubPageSection>
      <div role="status" aria-live="polite" className="text-body-sm text-muted">
        {busy && t('storageRecoveryWorking')}
        {failed && t('storageRecoveryFailed')}
        {result && !result.recovered && t('storageRecoveryIncomplete')}
        {result?.progress &&
          t('storageRecoveryProgress', {
            verifiedAccounts: result.progress.verifiedAccounts,
            expectedAccounts: result.progress.expectedAccounts,
            verifiedInputs: result.progress.verifiedInputs,
            expectedInputs: result.progress.expectedInputs
          })}
      </div>
    </SubPageLayout>
  );
};
