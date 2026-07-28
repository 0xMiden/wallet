import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import { guardianOptionForEndpoint, useCurrentGuardianEndpoint } from 'app/hooks/useCurrentGuardianEndpoint';
import { ReactComponent as GuardianAvatar } from 'app/icons/onboarding/guardian-avatar.svg';
import { Button } from 'components/Button';
import { hapticLight } from 'lib/mobile/haptics';
import { navigate } from 'lib/woozie';

const GuardianSettings: FC = () => {
  const { t } = useTranslation();
  const { endpoint: currentEndpoint } = useCurrentGuardianEndpoint();

  const option = guardianOptionForEndpoint(currentEndpoint);
  const guardianName = option?.name ?? (currentEndpoint ? t('customGuardian') : t('loading'));

  const handleRotate = () => {
    hapticLight();
    navigate('/rotate-guardian');
  };

  return (
    <div className="w-full flex flex-col">
      <div className="flex flex-col items-center pt-2">
        <div className="w-16 h-16 rounded-10 bg-grey-100 dark:bg-grey-800 flex items-center justify-center">
          <GuardianAvatar className="w-14 h-14" />
        </div>
        <h2 className="mt-3 text-xl font-bold font-heading text-heading-gray">{guardianName}</h2>
      </div>

      <hr className="my-4" />

      <div className="mt-6">
        <Button title={t('rotateGuardian')} onClick={handleRotate} />
      </div>
    </div>
  );
};

export default GuardianSettings;
