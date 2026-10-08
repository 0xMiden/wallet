import React, { FormEvent, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Button } from 'components/Button';
import { CodeInput } from 'components/ui/CodeInput';
import { TextAction } from 'components/ui/TextAction';
import { isMainnetAccessCodeComplete, MAINNET_ACCESS_CODE_LENGTH } from 'lib/mainnet-access';
import { getTestNetworkNameKey } from 'lib/miden-chain/effective-endpoints';

import { OnboardingStepLayout } from './OnboardingStepLayout';

export interface MainnetAccessScreenProps {
  /** Keep the code until account setup is complete. */
  onSubmit?: (code: string) => void;
  /** The user has no code and goes on with the test network. */
  onSkip?: () => void;
}

/** The body form's id: the submit button sits in the pinned footer, outside the form. */
const FORM_ID = 'onboarding-mainnet-access-form';

/**
 * Onboarding step shown after the first tap on Welcome, before the test-network notice. Mainnet is
 * invite-only: the user types the access code here, or goes on with the test network. On
 * mainnet there is nothing to unlock, so it renders nothing.
 */
export const MainnetAccessScreen: React.FC<MainnetAccessScreenProps> = ({ onSubmit, onSkip }) => {
  const { t } = useTranslation();
  const [code, setCode] = useState('');

  const networkKey = getTestNetworkNameKey();
  if (!networkKey) return null;
  const network = t(networkKey);

  const complete = isMainnetAccessCodeComplete(code);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!complete) return;
    onSubmit?.(code);
  };

  return (
    <OnboardingStepLayout
      data-testid="onboarding-mainnet-access"
      // The navigator's header names the step ("Mainnet access"), so the body has no title of its own.
      description={t('mainnetAccessOnboardingBody')}
      onSubmit={submit}
      formId={FORM_ID}
      footer={
        <>
          {/* The shared Button fires its own tap haptic. */}
          <Button
            type="submit"
            form={FORM_ID}
            className="max-w-none"
            title={t('unlockMainnet')}
            disabled={!complete}
            data-testid="onboarding-mainnet-access-submit"
          />
          <TextAction className="self-center" onClick={onSkip} data-testid="onboarding-mainnet-access-skip">
            {t('mainnetAccessContinueOnNetwork', { network })}
          </TextAction>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <span className="px-1 text-label text-muted">{t('mainnetAccessCodeLabel')}</span>
        <CodeInput
          value={code}
          onChange={setCode}
          length={MAINNET_ACCESS_CODE_LENGTH}
          groupSize={6}
          format="alphanumeric"
          label={t('mainnetAccessCodeLabel')}
          data-testid="onboarding-mainnet-access-code"
        />
        <span className="px-1 text-caption text-muted">{t('mainnetAccessHint')}</span>
      </div>
    </OnboardingStepLayout>
  );
};

export default MainnetAccessScreen;
