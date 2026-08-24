import React, { FC, useCallback, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { useCurrentGuardianEndpoint } from 'app/hooks/useCurrentGuardianEndpoint';
import PageLayout from 'app/layouts/PageLayout';
import { NavigationHeader } from 'components/NavigationHeader';
import { goBack, navigate } from 'lib/woozie';
import { ChooseGuardianScreen } from 'screens/onboarding/common/ChooseGuardian';

const RotateGuardian: FC = () => {
  const { t } = useTranslation();
  const { endpoint: currentEndpoint } = useCurrentGuardianEndpoint();
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(
    ({ guardianEndpoint }: { guardianId: string; guardianEndpoint: string }) => {
      if (guardianEndpoint === currentEndpoint) {
        setError(t('guardianEndpointUnchanged'));
        return;
      }
      setError(null);
      navigate({
        pathname: '/rotate-guardian/review',
        search: `?endpoint=${encodeURIComponent(guardianEndpoint)}`
      });
    },
    [currentEndpoint, t]
  );

  return (
    <PageLayout hideToolbar>
      <NavigationHeader title={t('rotateGuardian')} onBack={goBack} variant="prominent" titleAlign="left" />
      <ChooseGuardianScreen
        onSubmit={handleSubmit}
        currentEndpoint={currentEndpoint}
        allowCustomEndpoint
        error={error}
      />
    </PageLayout>
  );
};

export default RotateGuardian;
