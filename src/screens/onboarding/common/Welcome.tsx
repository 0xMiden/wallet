import React, { useState } from 'react';

import { useTranslation } from 'react-i18next';

import { useTapUnlock } from 'app/hooks/useTapUnlock';
import { ReactComponent as BreadLogo } from 'app/icons/brand/new-bread.svg';
import { Button, ButtonVariant } from 'components/Button';
import { SubPageLayout } from 'components/ui/SubPageLayout';
import { TextAction } from 'components/ui/TextAction';
import { navigate } from 'lib/woozie';

import { NoCodeSheet } from './NoCodeSheet';

export interface WelcomeScreenProps extends Omit<React.ButtonHTMLAttributes<HTMLDivElement>, 'onSubmit'> {
  onSubmit?: (action: Actions) => void;
  /** The invite-only way in, as the host decided it (OnboardingNetwork). */
  inviteOnly?: boolean;
  /** Seven logo taps call it while the general Welcome shows; without it they open Developer Settings. */
  onUnlockInviteOnly?: () => void;
  /** Recovery is the only way in: a new wallet needs a code the host cannot take. */
  recoverOnly?: boolean;
}

/**
 * `select-wallet-type` and `select-import-type` are the general ways in: the create and recover
 * flows behind the test-network notice. `mainnet-access` is the invite-only way in: the access-code
 * step.
 */
export type Actions = 'mainnet-access' | 'select-wallet-type' | 'select-import-type';

export const WelcomeScreen = ({
  onSubmit,
  inviteOnly = false,
  onUnlockInviteOnly,
  recoverOnly = false
}: WelcomeScreenProps) => {
  const { t } = useTranslation();
  const [noCodeOpen, setNoCodeOpen] = useState(false);

  // Seven logo taps unlock the invite-only Welcome, or open Developer Settings.
  const handleLogoTap = useTapUnlock(() => {
    if (inviteOnly || !onUnlockInviteOnly) {
      navigate('/developer-settings');
      return;
    }
    onUnlockInviteOnly();
  });

  const actions = inviteOnly ? (
    <>
      <Button
        tabIndex={0}
        className="max-w-none"
        data-testid="onboarding-have-code"
        title={t('iHaveACode')}
        onClick={() => onSubmit?.('mainnet-access')}
      />
      <Button
        id="import-link"
        className="max-w-none"
        variant={ButtonVariant.Secondary}
        data-testid="onboarding-recover-account"
        title={t('recoverYourAccount')}
        onClick={() => onSubmit?.('select-import-type')}
      />
      <TextAction
        className="self-center underline decoration-1 underline-offset-[3px]"
        data-testid="onboarding-no-code"
        onClick={() => setNoCodeOpen(true)}
      >
        {t('iDontHaveACode')}
      </TextAction>
    </>
  ) : (
    <>
      {!recoverOnly && (
        <Button
          tabIndex={0}
          className="max-w-none"
          data-testid="onboarding-get-started"
          title={t('getStarted')}
          onClick={() => onSubmit?.('select-wallet-type')}
        />
      )}
      {/* Recover: secondary under Get started, or the primary when it is alone (Button brings the haptic). */}
      <Button
        id="import-link"
        className="max-w-none"
        variant={recoverOnly ? ButtonVariant.Primary : ButtonVariant.Secondary}
        data-testid="onboarding-recover-account"
        title={t('recoverYourAccount')}
        onClick={() => onSubmit?.('select-import-type')}
      />
    </>
  );

  const footer = <div className="flex flex-col gap-2.5">{actions}</div>;

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
      <NoCodeSheet open={noCodeOpen} onOpenChange={setNoCodeOpen} />
    </SubPageLayout>
  );
};
