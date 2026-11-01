import React, {
  FC,
  ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore
} from 'react';

import { useTranslation } from 'react-i18next';

import { onboardingRegistrationActive, subscribeOnboardingRegistration } from 'app/templates/onboarding-registration';
import { Button } from 'components/Button';
import { ErrorLine } from 'components/ui/ErrorLine';
import { Spinner } from 'components/ui/Spinner';
import { SubPageLayout } from 'components/ui/SubPageLayout';
import { prepareMainnet } from 'lib/miden/prepare-mainnet';
import { getEffectiveNetworkName, hasDeveloperNetworkChoice } from 'lib/miden-chain/effective-endpoints';
import { isInviteOnlyRequired, useMainnetLaunched } from 'lib/remote-config/use-mainnet-launch';
import { WalletStatus } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';

/**
 * The one owner of the invite-only decision: the document's mainnet launch moment having passed
 * (`mainnetCountdown`), mainnet, or the Welcome's seven-tap unlock. Each moves a wallet that has not
 * been set up to mainnet before its children render, so the code check and the create run there.
 * A child already on screen stays mounted through a later preparation, covered and non-interactive
 * until it resolves, and still receives the live flag. Only wallets that have not been set up can
 * change networks here.
 */
export const OnboardingNetwork: FC<{
  children: (inviteOnly: boolean, onUnlockInviteOnly: () => void) => ReactNode;
  /** Show code entry without a remote config check. */
  requireInviteOnly?: boolean;
  /** Keep the welcome actions available while mainnet setup runs. */
  showWhilePreparing?: boolean;
}> = ({ children, requireInviteOnly = false, showWhilePreparing = false }) => {
  const { t } = useTranslation();
  const launched = useMainnetLaunched();
  const status = useWalletStore(s => s.status);
  const required =
    requireInviteOnly || isInviteOnlyRequired(launched, getEffectiveNetworkName(), hasDeveloperNetworkChoice());
  const [inviteOnly, setInviteOnly] = useState(required);
  const [state, setState] = useState<'idle' | 'pending' | 'ready' | 'failed'>('idle');
  const [attempt, setAttempt] = useState(0);
  const registrationActive = useSyncExternalStore(subscribeOnboardingRegistration, onboardingRegistrationActive);
  const mustPrepare = status === WalletStatus.Idle && (required || inviteOnly);
  // The attempt prepares mainnet itself. Hold this effect so that preparation does not cover the
  // screen or mark it inert while registration is still running.
  const armed = mustPrepare && !registrationActive;
  const unlockInviteOnly = useCallback(() => setInviteOnly(true), []);

  const ready = state === 'ready';
  const blocking = armed && !ready && (!showWhilePreparing || state === 'failed' || attempt > 0);
  // Latched once the child has been shown. Its step and credentials live there, so a later
  // preparation covers that child instead of unmounting it.
  const revealed = useRef(false);
  const flowRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!blocking) revealed.current = true;
    const flow = flowRef.current;
    if (!flow) return;
    flow.inert = blocking;
    if (blocking && flow.contains(document.activeElement) && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  }, [blocking]);

  useEffect(() => {
    if (!mustPrepare || registrationActive || ready || onboardingRegistrationActive()) return;
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
  }, [mustPrepare, registrationActive, attempt, ready]);

  const preparationStatus = (
    <SubPageLayout
      footer={
        state === 'failed' ? <Button title={t('retry')} onClick={() => setAttempt(value => value + 1)} /> : undefined
      }
    >
      <div role="status" aria-label={t('loading')} className="my-auto flex flex-col items-center gap-4">
        {state !== 'failed' && <Spinner size="lg" />}
        <ErrorLine errorId="devEndpointSaveFailed">{state === 'failed' ? t('devEndpointSaveFailed') : null}</ErrorLine>
      </div>
    </SubPageLayout>
  );

  // The first arrival has nothing on screen to keep, so it shows only the preparation screen.
  if (blocking && !revealed.current) return preparationStatus;

  return (
    <div className="relative h-full w-full">
      <div ref={flowRef} className={blocking ? 'pointer-events-none h-full w-full' : 'h-full w-full'}>
        {children(required || inviteOnly, unlockInviteOnly)}
      </div>
      {blocking ? <div className="absolute inset-0 z-10 flex min-h-0 flex-col">{preparationStatus}</div> : null}
    </div>
  );
};
