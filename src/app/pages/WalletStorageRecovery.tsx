import React, { useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import RootSuspenseFallback from 'app/a11y/RootSuspenseFallback';
import FullScreenPage from 'app/layouts/FullScreenPage';
import { SeedBackupGate } from 'app/templates/SeedBackupGate';
import { Button, ButtonVariant } from 'components/ui/Button';
import { SubPageLayout, SubPageSection } from 'components/ui/SubPageLayout';
import { backgroundLockPending } from 'lib/lock-up/background-lock';
import { requestLock } from 'lib/lock-up/lock-request';
import { useMidenContext } from 'lib/miden/front';
import type { WalletStorageRecoveryResult } from 'lib/shared/types';

type RecoveryState = 'idle' | 'working' | 'failed' | WalletStorageRecoveryResult;

const WalletStorageRecovery: React.FC<{
  rebuild: () => Promise<WalletStorageRecoveryResult>;
  onContinue: () => void;
}> = ({ rebuild, onContinue }) => {
  const { t } = useTranslation();
  const [state, setState] = useState<RecoveryState>('idle');
  const running = useRef(false);
  const working = state === 'working';
  const verified = typeof state === 'object';

  const handleRebuild = async () => {
    if (running.current) return;
    running.current = true;
    setState('working');
    try {
      setState(await rebuild());
    } catch {
      setState('failed');
    } finally {
      running.current = false;
    }
  };

  return (
    <main className="mx-auto h-full w-full max-w-[600px]">
      <FullScreenPage entrance="fade">
        <SubPageLayout
          title={t(verified ? 'storageRecoveryVerified' : 'storageRecoveryTitle')}
          focusTitleOnMount
          footer={
            <Button
              className="max-w-none"
              disabled={working}
              isLoading={working}
              onClick={verified ? onContinue : handleRebuild}
            >
              {t(verified ? 'continue' : 'storageRecoveryRebuild')}
            </Button>
          }
          footerNavbarCushion={false}
        >
          <SubPageSection description={verified ? undefined : t('storageRecoveryDescription')}>
            <div role="status" aria-atomic="true" className="px-1 text-body-sm text-muted">
              {working && t('storageRecoveryWorking')}
              {state === 'failed' && t('storageRecoveryFailed')}
              {typeof state === 'object' && t('storageRecoveryProgress', { ...state })}
            </div>
            {state === 'failed' && (
              <Button variant={ButtonVariant.Secondary} onClick={() => void requestLock().catch(() => {})}>
                {t('storageRecoveryUnlockOptions')}
              </Button>
            )}
          </SubPageSection>
        </SubPageLayout>
      </FullScreenPage>
    </main>
  );
};

export const WalletSurfaceGate: React.FC<React.PropsWithChildren> = ({ children }) => {
  const { hydrated, locked, storageUnavailable, rebuildWalletStorage } = useMidenContext();
  const lockPending = backgroundLockPending.useValue();
  const [rebuilding, setRebuilding] = useState(false);
  if (hydrated && !locked && (storageUnavailable || rebuilding)) {
    // Recovery must take priority over both account prompts and approval windows.
    return lockPending ? (
      <RootSuspenseFallback />
    ) : (
      <WalletStorageRecovery
        rebuild={async () => {
          setRebuilding(true);
          try {
            return await rebuildWalletStorage();
          } catch (error) {
            setRebuilding(false);
            throw error;
          }
        }}
        onContinue={() => setRebuilding(false)}
      />
    );
  }
  return <SeedBackupGate>{children}</SeedBackupGate>;
};
