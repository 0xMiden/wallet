import React, { useEffect, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { ReactComponent as BreadLogo } from 'app/icons/brand/new-bread.svg';
import { Button, ButtonVariant } from 'components/Button';
import { SubPageLayout } from 'components/ui/SubPageLayout';
import { TextAction } from 'components/ui/TextAction';
import { isInviteOnboardingUnlocked, setInviteOnboardingUnlocked, welcomeOnboarding } from 'lib/invite-onboarding';
import { hapticLight, hapticMedium } from 'lib/mobile/haptics';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';
import { selectInviteOnlyOnboarding } from 'lib/remote-config/values';
import { cn } from 'lib/ui/util';
import { navigate } from 'lib/woozie';

import { NoCodeSheet } from './NoCodeSheet';

export interface WelcomeScreenProps extends Omit<React.ButtonHTMLAttributes<HTMLDivElement>, 'onSubmit'> {
  onSubmit?: (action: Actions) => void;
}

/**
 * `select-wallet-type` and `select-import-type` are the general ways in: the create and recover
 * flows behind the test-network notice. `mainnet-access` is the invite-only way in: the access-code
 * step.
 */
export type Actions = 'mainnet-access' | 'select-wallet-type' | 'select-import-type';

/** The number of logo taps that unlock the invite-only Welcome, or open Developer Settings. */
const UNLOCK_TAPS = 7;

/**
 * The maximum time the actions stay hidden while the remote config loads, so that the variant the
 * config sets does not replace the other one under the user's finger.
 */
const CONFIG_WAIT_MS = 3_000;

/** True when the remote config has loaded, or the wait for it has ended. */
function useConfigSettled(loading: boolean): boolean {
  const [waitEnded, setWaitEnded] = useState(false);
  useEffect(() => {
    if (!loading) return undefined;
    const timer = setTimeout(() => setWaitEnded(true), CONFIG_WAIT_MS);
    return () => clearTimeout(timer);
  }, [loading]);
  return !loading || waitEnded;
}

export const WelcomeScreen = ({ onSubmit }: WelcomeScreenProps) => {
  const { t } = useTranslation();
  const tapCount = useRef(0);
  const lastTap = useRef(0);
  const snapshot = useBridgeConfigSnapshot();
  const settled = useConfigSettled(snapshot.status === 'loading');
  const [unlocked, setUnlocked] = useState(isInviteOnboardingUnlocked);
  const [noCodeOpen, setNoCodeOpen] = useState(false);
  const { inviteOnly, tapsUnlockInviteOnly } = welcomeOnboarding(selectInviteOnlyOnboarding(snapshot), unlocked);
  // Hidden, not removed, so the hero does not move when the actions show.
  const actionClassName = cn('max-w-none', !settled && 'invisible');

  // When the remote config sets no variant, seven taps unlock the invite-only Welcome and seven
  // more open Developer Settings. When the config sets the variant, seven taps open Developer
  // Settings.
  const handleLogoTap = (e: React.MouseEvent) => {
    e.preventDefault();
    window.getSelection()?.removeAllRanges();
    const now = e.timeStamp;
    tapCount.current = now - lastTap.current > 2000 ? 1 : tapCount.current + 1;
    lastTap.current = now;
    if (tapCount.current >= 4 && tapCount.current < UNLOCK_TAPS) hapticLight();
    if (tapCount.current < UNLOCK_TAPS) return;
    tapCount.current = 0;
    hapticMedium();
    if (!tapsUnlockInviteOnly) {
      navigate('/developer-settings');
      return;
    }
    setInviteOnboardingUnlocked(true);
    setUnlocked(true);
  };

  const footer = inviteOnly ? (
    <>
      <Button
        tabIndex={0}
        className={actionClassName}
        data-testid="onboarding-have-code"
        title={t('iHaveACode')}
        onClick={() => onSubmit?.('mainnet-access')}
      />
      {/* No code: Bread is invite-only, and the sheet says so (TextAction brings the haptic). */}
      <TextAction
        className={cn('self-center underline decoration-1 underline-offset-[3px]', !settled && 'invisible')}
        data-testid="onboarding-no-code"
        onClick={() => setNoCodeOpen(true)}
      >
        {t('iDontHaveACode')}
      </TextAction>
    </>
  ) : (
    <>
      <Button
        tabIndex={0}
        className={actionClassName}
        data-testid="onboarding-get-started"
        title={t('getStarted')}
        onClick={() => onSubmit?.('select-wallet-type')}
      />
      {/* The second way in, as the secondary action under the primary one (Button brings the haptic). */}
      <Button
        id="import-link"
        className={actionClassName}
        variant={ButtonVariant.Secondary}
        data-testid="onboarding-recover-account"
        title={t('recoverYourAccount')}
        onClick={() => onSubmit?.('select-import-type')}
      />
    </>
  );

  return (
    <SubPageLayout data-testid="onboarding-welcome" footerLayout="stack" footer={footer}>
      <div className="my-auto flex flex-col items-center py-8 text-center">
        <div
          data-testid="onboarding-bread-logo"
          data-invite-onboarding={inviteOnly ? 'true' : undefined}
          onClick={handleLogoTap}
          className="cursor-default select-none [-webkit-touch-callout:none]"
        >
          <BreadLogo className="h-auto w-[140px]" />
        </div>
        <h1 className="mt-6 font-heading text-[min(56px,15vw)] leading-[1.07] font-extrabold tracking-[-0.5px] [overflow-wrap:anywhere] text-ink">
          <span className="block">{t('welcome')}</span>
          <span className="block">
            {t('toLowercase')} {t('midenWallet')}
          </span>
        </h1>
        <p className="mt-3 max-w-80 font-heading text-base leading-6 font-semibold text-muted">
          {t('breadWalletDescription')}
        </p>
      </div>
      <NoCodeSheet
        open={noCodeOpen}
        onOpenChange={setNoCodeOpen}
        onRecover={() => {
          setNoCodeOpen(false);
          onSubmit?.('select-import-type');
        }}
      />
    </SubPageLayout>
  );
};
