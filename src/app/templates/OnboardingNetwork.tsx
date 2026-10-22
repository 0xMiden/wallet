import React, { FC, ReactNode, useCallback, useEffect, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Button } from 'components/Button';
import { ErrorLine } from 'components/ui/ErrorLine';
import { Spinner } from 'components/ui/Spinner';
import { SubPageLayout } from 'components/ui/SubPageLayout';
import { prepareMainnet } from 'lib/miden/prepare-mainnet';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { isInviteOnlyRequired, useMainnetLaunched } from 'lib/remote-config/use-mainnet-launch';
import { WalletStatus } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';

/**
 * The one owner of the invite-only decision: the document's mainnet launch moment having passed
 * (`mainnetCountdown`), mainnet, or the Welcome's seven-tap unlock. Each moves a wallet that has not
 * been set up to mainnet before its children render, so the code check and the create run there. Only
 * wallets that have not been set up can change networks here.
 */
export const OnboardingNetwork: FC<{
  children: (inviteOnly: boolean, onUnlockInviteOnly: () => void) => ReactNode;
}> = ({ children }) => {
  const { t } = useTranslation();
  const launched = useMainnetLaunched();
  const status = useWalletStore(s => s.status);
  const required = isInviteOnlyRequired(launched, getEffectiveNetworkName());
  const [inviteOnly, setInviteOnly] = useState(required);
  const [state, setState] = useState<'idle' | 'pending' | 'ready' | 'failed'>('idle');
  const [attempt, setAttempt] = useState(0);
  const mustPrepare = status === WalletStatus.Idle && (required || inviteOnly);
  const unlockInviteOnly = useCallback(() => setInviteOnly(true), []);

  const ready = state === 'ready';

  useEffect(() => {
    if (!mustPrepare || ready) return;
    let active = true;
    setInviteOnly(true);
    setState('pending');
    prepareMainnet().then(
      () => {
        if (active) setState('ready');
      },
      () => {
        if (active) setState('failed');
      }
    );
    return () => {
      active = false;
    };
  }, [mustPrepare, attempt, ready]);

  if (mustPrepare && state !== 'ready') {
    return (
      <SubPageLayout
        footer={
          state === 'failed' ? <Button title={t('retry')} onClick={() => setAttempt(value => value + 1)} /> : undefined
        }
      >
        <div role="status" aria-label={t('loading')} className="my-auto flex flex-col items-center gap-4">
          {state !== 'failed' && <Spinner size="lg" />}
          <ErrorLine errorId="devEndpointSaveFailed">
            {state === 'failed' ? t('devEndpointSaveFailed') : null}
          </ErrorLine>
        </div>
      </SubPageLayout>
    );
  }

  return <>{children(required || inviteOnly, unlockInviteOnly)}</>;
};
