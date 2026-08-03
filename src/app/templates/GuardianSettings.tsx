import React, { FC } from 'react';

import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import { guardianOptionForEndpoint, useCurrentGuardianEndpoint } from 'app/hooks/useCurrentGuardianEndpoint';
import { GUARDIAN_LOGOS, guardianLogoColorClass } from 'app/icons/guardian-operator-logs';
import { ReactComponent as GuardianAvatar } from 'app/icons/onboarding/guardian-avatar.svg';
import { Button } from 'components/Button';
import { hapticLight } from 'lib/mobile/haptics';
import { navigate } from 'lib/woozie';

const GuardianSettings: FC = () => {
  const { t } = useTranslation();
  const { endpoint: currentEndpoint } = useCurrentGuardianEndpoint();

  const option = guardianOptionForEndpoint(currentEndpoint);
  const guardianName = option?.name ?? (currentEndpoint ? t('customGuardian') : t('loading'));
  // Custom endpoints have no brand asset — keep the generic avatar for those.
  const logoEntry = option ? GUARDIAN_LOGOS[option.id] : undefined;
  const OperatorLogo = logoEntry?.Logo;

  const handleRotate = () => {
    hapticLight();
    navigate('/rotate-guardian');
  };

  return (
    <div className="w-full flex flex-col">
      <div className="flex flex-col items-center pt-2">
        <div className="h-16 min-w-16 px-4 rounded-10 bg-grey-100 dark:bg-grey-800 flex items-center justify-center">
          {OperatorLogo && logoEntry ? (
            // h-7 w-auto normalizes the differently-sized wordmarks to one height.
            <OperatorLogo className={clsx('h-7 w-auto', guardianLogoColorClass(logoEntry))} />
          ) : (
            <GuardianAvatar className="w-14 h-14" />
          )}
        </div>
        <h2 className="mt-3 text-xl font-bold font-heading text-heading-gray">{guardianName}</h2>
      </div>

      <hr className="my-4" />

      <div className="mt-6">
        <Button data-testid="rotateGuardian" title={t('rotateGuardian')} onClick={handleRotate} />
      </div>
    </div>
  );
};

export default GuardianSettings;
