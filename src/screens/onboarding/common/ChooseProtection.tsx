import React from 'react';

import { useTranslation } from 'react-i18next';

import { ReactComponent as ProtectedIllustration } from 'app/icons/onboarding/protected-illustration.svg';
import { Button, ButtonVariant } from 'components/Button';

import { OnboardingStepLayout } from './OnboardingStepLayout';

export interface ChooseProtectionScreenProps {
  onSelectBiometric?: () => void;
  onSelectPasscode?: () => void;
}

export const ChooseProtectionScreen: React.FC<ChooseProtectionScreenProps> = ({
  onSelectBiometric,
  onSelectPasscode
}) => {
  const { t } = useTranslation();
  return (
    <OnboardingStepLayout
      data-testid="onboarding-choose-protection"
      title={t('chooseHowToProtect')}
      footer={
        <>
          <Button className="max-w-none" title={t('useFaceIdOrBiometric')} onClick={onSelectBiometric} />
          <Button
            className="max-w-none"
            title={t('setUpYourPasscode')}
            variant={ButtonVariant.Secondary}
            onClick={onSelectPasscode}
          />
        </>
      }
    >
      <div className="my-auto flex justify-center py-6">
        <ProtectedIllustration aria-hidden="true" className="h-auto w-full max-w-[278px]" />
      </div>
    </OnboardingStepLayout>
  );
};

export default ChooseProtectionScreen;
