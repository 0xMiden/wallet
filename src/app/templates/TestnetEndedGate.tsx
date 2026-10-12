import React, { FC, useEffect, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { useOnboardingFinishing } from 'app/onboarding-finish';
import { Button } from 'components/Button';
import { ErrorLine } from 'components/ui/ErrorLine';
import { putToStorage, useStorage } from 'lib/miden/front/storage';
import { resetWalletAndReload } from 'lib/miden/reset-and-reload';
import { getTestNetworkNameKey } from 'lib/miden-chain/effective-endpoints';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';
import { selectInviteOnlyOnboarding } from 'lib/remote-config/values';
import { WalletStatus } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';
import { INVITE_ONBOARDING_SETUP_STORAGE_KEY, isTestnetEnded } from 'lib/testnet-ended';

/**
 * The end of a test network. When the remote wallet config sets `onboarding.inviteOnly` and a
 * wallet set up before that is still on a test network, this overlay covers the wallet, locked or
 * ready, and offers one action: the reset, which clears every storage and reloads into onboarding.
 * Nothing else is reachable while it shows; see `lib/testnet-ended.ts` for the rule.
 *
 * It also writes the marker the rule reads: when an onboarding holder takes the finishing mark
 * under the invite-only config, the wallet being registered is one the invite-only Welcome creates,
 * and it must not be gated. The mark is taken before registration, so the marker lands before the
 * holder navigates on and the gate re-evaluates.
 */
export const TestnetEndedGate: FC = () => {
  const status = useWalletStore(s => s.status);
  const finishingOnboarding = useOnboardingFinishing();
  const snapshot = useBridgeConfigSnapshot();
  const inviteOnly = selectInviteOnlyOnboarding(snapshot);
  const [setUpUnderInvite] = useStorage<boolean>(INVITE_ONBOARDING_SETUP_STORAGE_KEY, false);

  useEffect(() => {
    if (!finishingOnboarding || inviteOnly !== true) return;
    putToStorage(INVITE_ONBOARDING_SETUP_STORAGE_KEY, true).catch(error =>
      console.warn('[testnet-ended] Could not record the invite-only setup', error)
    );
  }, [finishingOnboarding, inviteOnly]);

  const networkKey = getTestNetworkNameKey();
  const ended = isTestnetEnded({
    inviteOnly,
    onTestNetwork: networkKey !== null,
    walletExists: status !== WalletStatus.Idle,
    finishingOnboarding,
    setUpUnderInvite
  });
  if (!ended || networkKey === null) return null;
  return <TestnetEndedOverlay networkKey={networkKey} />;
};

const TestnetEndedOverlay: FC<{ networkKey: 'testnet' | 'devnet' | 'localnet' }> = ({ networkKey }) => {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  // Hardware and gesture back do nothing while the wallet is blocked.
  useMobileBackHandler(() => true, [], { overlay: true });

  const reset = async () => {
    if (pending) return;
    setPending(true);
    setFailed(false);
    try {
      await resetWalletAndReload(async error => {
        console.warn('[testnet-ended] Could not wipe the wallet storage', error);
        setFailed(true);
      });
    } catch (error) {
      console.warn('[testnet-ended] The reset did not finish', error);
      setFailed(true);
    } finally {
      setPending(false);
    }
  };

  const network = t(networkKey);

  return (
    <div
      data-testid="testnet-ended-gate"
      role="dialog"
      aria-modal="true"
      aria-labelledby="testnet-ended-title"
      className="fixed inset-0 z-[9999] flex flex-col items-center overflow-y-auto px-8 pt-[max(2rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))] text-center bg-pure-white/10 dark:bg-pure-black/50 [backdrop-filter:blur(24px)_saturate(1.5)] [-webkit-backdrop-filter:blur(24px)_saturate(1.5)]"
    >
      {/* `my-auto` centres the content and lets a taller one scroll from its top instead of clipping. */}
      <div className="my-auto flex w-full flex-col items-center gap-4">
        <h1 id="testnet-ended-title" className="text-lg font-semibold text-ink">
          {t('testnetEndedTitle', { network })}
        </h1>
        <p className="text-sm text-ink select-text">{t('testnetEndedBody', { network })}</p>
        <ErrorLine data-testid="testnet-ended-error">{failed ? t('resetDidNotFinish') : null}</ErrorLine>
        {/* The shared Button fires its own tap haptic. */}
        <Button
          title={t('testnetEndedReset')}
          onClick={reset}
          isLoading={pending}
          className="w-full"
          data-testid="testnet-ended-reset"
        />
      </div>
    </div>
  );
};

export default TestnetEndedGate;
