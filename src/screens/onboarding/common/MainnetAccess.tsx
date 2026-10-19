import React, { useEffect } from 'react';

import { useTranslation } from 'react-i18next';

import { Button } from 'components/Button';
import { MainnetCodeEntryFields, useMainnetCodeEntry } from 'components/MainnetCodeEntry';
import { readCarriedMainnetAccessCode } from 'lib/carried-mainnet-code';
import { checkMainnetAccessCode } from 'lib/mainnet-access';

import { OnboardingStepLayout } from './OnboardingStepLayout';

export interface MainnetAccessScreenProps {
  /** The node accepted the code. Keep it until account setup is complete. */
  onSubmit?: (code: string) => void;
  /** The node refused the code a registration carried: the screen opens with the refusal. */
  rejected?: boolean;
}

/** The body form's id: the submit button sits in the pinned footer, outside the form. */
const FORM_ID = 'onboarding-mainnet-access-form';

/**
 * Onboarding step after Welcome's "I have a code". Bread is invite-only: the node checks the
 * access code here, and an accepted code is held until the final account exists, which the code
 * then registers. The check does not use the code.
 */
export const MainnetAccessScreen: React.FC<MainnetAccessScreenProps> = ({ onSubmit, rejected = false }) => {
  const { t } = useTranslation();
  const entry = useMainnetCodeEntry({ check: checkMainnetAccessCode, onGranted: onSubmit, rejected });
  const { offerCode } = entry;

  // A switch to mainnet carries the code it accepted, so it is not typed again; the node checks it once more.
  useEffect(() => {
    let active = true;
    void readCarriedMainnetAccessCode().then(carried => {
      if (active && carried) offerCode(carried);
    });
    return () => {
      active = false;
    };
  }, [offerCode]);

  return (
    <OnboardingStepLayout
      data-testid="onboarding-mainnet-access"
      title={t('mainnetAccessTitle')}
      description={t('mainnetAccessOnboardingBody')}
      onSubmit={entry.submit}
      formId={FORM_ID}
      footer={
        // The shared Button fires its own tap haptic.
        <Button
          type="submit"
          form={FORM_ID}
          className="max-w-none"
          title={t('unlockMainnet')}
          disabled={!entry.complete || entry.pasting}
          isLoading={entry.submitting}
          data-testid="onboarding-mainnet-access-submit"
        />
      }
    >
      <MainnetCodeEntryFields entry={entry} testIdPrefix="onboarding-mainnet-access" className="pt-5" />
    </OnboardingStepLayout>
  );
};

export default MainnetAccessScreen;
