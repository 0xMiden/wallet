import React, { FormEvent, useState } from 'react';

import { Clipboard } from '@capacitor/clipboard';
import { useTranslation } from 'react-i18next';

import { Button } from 'components/Button';
import { CodeInput } from 'components/ui/CodeInput';
import { ErrorLine } from 'components/ui/ErrorLine';
import { TextAction } from 'components/ui/TextAction';
import { checkMainnetAccessCode, isMainnetAccessCodeComplete, MAINNET_ACCESS_CODE_LENGTH } from 'lib/mainnet-access';

import { OnboardingStepLayout } from './OnboardingStepLayout';

export interface MainnetAccessScreenProps {
  /** The node accepted the code. Keep it until account setup is complete. */
  onSubmit?: (code: string) => void;
  /** The node refused the code a registration carried: the screen opens with the refusal. */
  rejected?: boolean;
}

/** The body form's id: the submit button sits in the pinned footer, outside the form. */
const FORM_ID = 'onboarding-mainnet-access-form';

/** Why the last try did not unlock mainnet: the code was refused, or the check did not complete. */
type Failure = 'rejected' | 'unchecked' | 'clipboard';

/**
 * Onboarding step after Welcome's "I have a code". Bread is invite-only: the node checks the
 * access code here, and an accepted code is held until the final account exists, which the code
 * then registers. The check does not use the code.
 */
export const MainnetAccessScreen: React.FC<MainnetAccessScreenProps> = ({ onSubmit, rejected = false }) => {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [failure, setFailure] = useState<Failure | null>(rejected ? 'rejected' : null);
  const [submitting, setSubmitting] = useState(false);
  const [pasting, setPasting] = useState(false);

  const complete = isMainnetAccessCodeComplete(code);

  // Literal keys, so the key-coverage test can find them.
  const failureMessage = (): string | null => {
    switch (failure) {
      case 'rejected':
        return t('mainnetAccessCodeRejected');
      case 'unchecked':
        return t('mainnetAccessCheckFailed');
      case 'clipboard':
        return t('mainnetAccessPasteFailed');
      case null:
        return null;
    }
  };

  const changeCode = (next: string) => {
    setCode(next);
    setFailure(null);
  };

  const pasteCode = async () => {
    if (pasting || submitting) return;
    setPasting(true);
    try {
      const { value, type } = await Clipboard.read();
      if (type !== 'text/plain' || !value) return;
      changeCode(value.replace(/[^A-Za-z0-9]/g, '').slice(0, MAINNET_ACCESS_CODE_LENGTH));
    } catch {
      setFailure('clipboard');
    } finally {
      setPasting(false);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!complete || submitting || pasting) return;
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
          disabled={!complete || pasting}
          isLoading={submitting}
          data-testid="onboarding-mainnet-access-submit"
        />
      }
    >
      <div className="flex flex-col gap-3 pt-5">
        <div className="flex items-center justify-between px-1">
          <span className="text-label text-muted">{t('mainnetAccessCodeLabel')}</span>
          <TextAction
            onClick={pasteCode}
            disabled={submitting || pasting}
            data-testid="onboarding-mainnet-access-paste"
          >
            {t('paste')}
          </TextAction>
        </div>
        <CodeInput
          value={code}
          onChange={changeCode}
          length={MAINNET_ACCESS_CODE_LENGTH}
          layout="vertical"
          groupSize={6}
          format="alphanumeric"
          label={t('mainnetAccessCodeLabel')}
          invalid={failure !== null}
          disabled={submitting || pasting}
          data-testid="onboarding-mainnet-access-code"
        />
        <span className="px-1 text-caption text-muted">{t('mainnetAccessHint')}</span>
        <ErrorLine data-testid="onboarding-mainnet-access-error">{failureMessage()}</ErrorLine>
      </div>
    </OnboardingStepLayout>
  );
};

export default MainnetAccessScreen;
