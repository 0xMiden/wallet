import React from 'react';

import { useTranslation } from 'react-i18next';

import { ReactComponent as LockIcon } from 'app/icons/onboarding/lock.svg';
import { Button, ButtonVariant } from 'components/Button';

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
    <div className="bg-app-bg h-full overflow-y-auto" data-testid="onboarding-choose-protection">
      <div className="min-h-full flex flex-col items-center px-6">
        <div className="flex-1 flex flex-col items-center justify-center w-full py-8">
          <LockIcon style={{ width: 131, height: 154 }} />
          <h1 className="text-5xl font-semibold font-heading text-heading-gray text-center mt-10 leading-[105%] tracking-tight">
            {t('chooseHowToProtect')}
          </h1>
        </div>

        <div className="w-full flex flex-col items-center gap-4 pb-6 shrink-0">
          <Button title={t('useFaceIdOrBiometric')} onClick={onSelectBiometric} />
          <Button title={t('setUpYourPasscode')} variant={ButtonVariant.Ghost} onClick={onSelectPasscode} />
        </div>
      </div>
    </div>
  );
};

export default ChooseProtectionScreen;
