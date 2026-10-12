import React, { FormEvent, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Button } from 'components/Button';
import { CodeInput } from 'components/ui/CodeInput';
import { ErrorLine } from 'components/ui/ErrorLine';
import { checkMainnetAccessCode, isMainnetAccessCodeComplete, MAINNET_ACCESS_CODE_LENGTH } from 'lib/mainnet-access';

import { OnboardingStepLayout } from './OnboardingStepLayout';

export interface MainnetAccessScreenProps {
  /** The node accepted the code. Keep it until account setup is complete. */
  onSubmit?: (code: string) => void;
}

/** The body form's id: the submit button sits in the pinned footer, outside the form. */
const FORM_ID = 'onboarding-mainnet-access-form';

/** Why the last try did not unlock mainnet: the code was refused, or the check did not complete. */
type Failure = 'rejected' | 'unchecked';

/**
 * Onboarding step after Welcome's "I have a code". Bread is invite-only: the node checks the
 * access code here, and an accepted code is held until the final account exists, which the code
 * then registers. The check does not use the code.
 */
export const MainnetAccessScreen: React.FC<MainnetAccessScreenProps> = ({ onSubmit }) => {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [failure, setFailure] = useState<Failure | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const complete = isMainnetAccessCodeComplete(code);

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
      const outcome = await checkMainnetAccessCode(code);
      switch (outcome) {
        case 'granted':
          onSubmit?.(code);
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
      title={t('mainnetAccessTitle')}
      description={t('mainnetAccessOnboardingBody')}
      onSubmit={submit}
      formId={FORM_ID}
      footer={
        // The shared Button fires its own tap haptic.
        <Button
          type="submit"
          form={FORM_ID}
          className="max-w-none"
          title={t('unlockMainnet')}
          disabled={!complete}
          isLoading={submitting}
          data-testid="onboarding-mainnet-access-submit"
        />
      }
    >
      <div className="flex flex-col gap-3 pt-5">
        <span className="px-1 text-label text-muted">{t('mainnetAccessCodeLabel')}</span>
        <CodeInput
          value={code}
          onChange={changeCode}
          length={MAINNET_ACCESS_CODE_LENGTH}
          groupSize={6}
          format="alphanumeric"
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
