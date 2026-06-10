import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import {
  guardianEndpointHost,
  guardianOptionForEndpoint,
  useCurrentGuardianEndpoint
} from 'app/hooks/useCurrentGuardianEndpoint';
import { ReactComponent as GuardianAvatar } from 'app/icons/onboarding/guardian-avatar.svg';
import { Button } from 'components/Button';
import { hapticLight } from 'lib/mobile/haptics';
import { DetailCard, DetailRow } from 'lib/ui/DetailCard';
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

      <p className="mt-6 text-sm font-semibold text-text-tertiary-token">{t('about')}</p>
      <p className="mt-2 text-base text-heading-gray leading-snug select-text">{t('guardianAboutDescription')}</p>

      <hr className="my-4" />

      <p className="text-sm font-semibold text-text-tertiary-token">{t('details')}</p>
      <div className="mt-2">
        <DetailCard>
          <DetailRow label={t('guardianProvider')} value={option?.operatedBy ?? t('customGuardian')} />
          <DetailRow label={t('guardianEndpointLabel')} isLast={!option}>
            <span className="text-sm font-medium text-heading-gray text-right break-all select-text">
              {currentEndpoint ? guardianEndpointHost(currentEndpoint) : t('loading')}
            </span>
          </DetailRow>
          {option && <DetailRow label={t('guardianRegion')} value={option.location} isLast />}
        </DetailCard>
      </div>

      <div className="mt-6">
        <Button title={t('rotateGuardian')} onClick={handleRotate} />
      </div>
    </div>
  );
};

export default GuardianSettings;
