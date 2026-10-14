import React, { FC, ReactNode, useCallback, useEffect, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Button } from 'components/Button';
import { ErrorLine } from 'components/ui/ErrorLine';
import { Spinner } from 'components/ui/Spinner';
import { SubPageLayout } from 'components/ui/SubPageLayout';
import { request } from 'lib/miden/front';
import {
  applyEndpointOverride,
  buildDefaultOverrideFor,
  getEffectiveNetworkName
} from 'lib/miden-chain/effective-endpoints';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import { isExtension } from 'lib/platform';
import { followEffectiveNetwork } from 'lib/remote-config/runtime';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';
import { selectInviteOnlyOnboarding } from 'lib/remote-config/values';
import { WalletMessageType, WalletStatus } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';

let preparing: Promise<void> | undefined;

/** Complete the network change before a code check or recovery can start. */
function prepareMainnet(): Promise<void> {
  if (preparing) return preparing;
  preparing = (async () => {
    await applyEndpointOverride(buildDefaultOverrideFor(MIDEN_NETWORK_NAME.MAINNET));
    if (isExtension()) {
      await request({ type: WalletMessageType.ReloadEndpointOverridesRequest });
    } else {
      const { resetMidenClient } = await import('lib/miden/sdk/miden-client');
      await resetMidenClient();
    }
    followEffectiveNetwork();
  })().finally(() => {
    preparing = undefined;
  });
  return preparing;
}

/**
 * The one owner of the invite-only decision: the document's `onboarding.inviteOnly`, mainnet, or the
 * Welcome's seven-tap unlock. Each moves a wallet that has not been set up to mainnet before its
 * children render, so the code check and the create run there. Only wallets that have not been set
 * up can change networks here.
 */
export const OnboardingNetwork: FC<{
  children: (inviteOnly: boolean, onUnlockInviteOnly: () => void) => ReactNode;
}> = ({ children }) => {
  const { t } = useTranslation();
  const snapshot = useBridgeConfigSnapshot();
  const status = useWalletStore(s => s.status);
  const required =
    selectInviteOnlyOnboarding(snapshot) === true || getEffectiveNetworkName() === MIDEN_NETWORK_NAME.MAINNET;
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
          <ErrorLine>{state === 'failed' ? t('devEndpointSaveFailed') : null}</ErrorLine>
        </div>
      </SubPageLayout>
    );
  }

  return <>{children(required || inviteOnly, unlockInviteOnly)}</>;
};
