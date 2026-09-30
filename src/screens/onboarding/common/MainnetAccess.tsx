import React, { FormEvent, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Button } from 'components/Button';
import { CodeInput } from 'components/ui/CodeInput';
import { ErrorLine } from 'components/ui/ErrorLine';
import { TextAction } from 'components/ui/TextAction';
import { MAINNET_ACCESS_CODE_LENGTH, redeemMainnetAccessCode } from 'lib/mainnet-access';
import { getTestNetworkNameKey } from 'lib/miden-chain/effective-endpoints';

import { OnboardingStepLayout } from './OnboardingStepLayout';

export interface MainnetAccessScreenProps {
  /** The code was accepted. */
  onSubmit?: () => void;
  /** The user has no code and goes on with the test network. */
  onSkip?: () => void;
}

/** Why the last try did not open mainnet: the code was refused, or the check did not complete. */
type Failure = 'rejected' | 'unchecked';

/** The body form's id: the submit button sits in the pinned footer, outside the form. */
const FORM_ID = 'onboarding-mainnet-access-form';

/**
 * Onboarding step shown after the first tap on Welcome, before the test-network notice. Mainnet is
 * invite-only: the user types the 8-digit access code here, or goes on with the test network. On
 * mainnet there is nothing to unlock, so it renders nothing.
 */
export const MainnetAccessScreen: React.FC<MainnetAccessScreenProps> = ({ onSubmit, onSkip }) => {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [failure, setFailure] = useState<Failure | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const networkKey = getTestNetworkNameKey();
  if (!networkKey) return null;
  const network = t(networkKey);

  const complete = code.length === MAINNET_ACCESS_CODE_LENGTH;

  // Literal keys, so the key-coverage test can find them.
  const failureMessage = (): string | null => {
    switch (failure) {
      case 'rejected':
        return t('mainnetAccessCodeRejected');
      case 'unchecked':
        return t('mainnetAccessCheckFailed');
      case null:
        return null;
    }
  };

  const changeCode = (next: string) => {
    setCode(next);
    setFailure(null);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!complete || submitting) return;
    setSubmitting(true);
    setFailure(null);
    try {
      const outcome = await redeemMainnetAccessCode(code);
      switch (outcome) {
        case 'granted':
          onSubmit?.();
          break;
        case 'rejected':
          setFailure('rejected');
          break;
      }
    } catch {
      setFailure('unchecked');
    } finally {
      setSubmitting(false);
    }
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
            isLoading={submitting}
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
          onChange={changeCode}
          length={MAINNET_ACCESS_CODE_LENGTH}
          label={t('mainnetAccessCodeLabel')}
          invalid={failure !== null}
          disabled={submitting}
          data-testid="onboarding-mainnet-access-code"
        />
        <span className="px-1 text-caption text-muted">{t('mainnetAccessHint')}</span>
        <ErrorLine data-testid="onboarding-mainnet-access-error">{failureMessage()}</ErrorLine>
      </div>
    </OnboardingStepLayout>
  );
};

export default MainnetAccessScreen;
