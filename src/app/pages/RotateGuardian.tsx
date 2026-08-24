import React, { FC, useCallback, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { useBackWithFallback } from 'app/hooks/useBackWithFallback';
import { useCurrentGuardianEndpoint } from 'app/hooks/useCurrentGuardianEndpoint';
import PageLayout from 'app/layouts/PageLayout';
import { NavigationHeader } from 'components/NavigationHeader';
import { navigate } from 'lib/woozie';
import { ChooseGuardianScreen } from 'screens/onboarding/common/ChooseGuardian';

const RotateGuardian: FC = () => {
  const { t } = useTranslation();
  const { endpoint: currentEndpoint } = useCurrentGuardianEndpoint();
  const [error, setError] = useState<string | null>(null);
  // Both entry points into the picker are Settings pages (Guardian Settings and
  // Keys), so a cold load belongs back in Settings rather than at the wallet home.
  const handleBack = useBackWithFallback('/settings');

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
      <NavigationHeader title={t('rotateGuardian')} onBack={handleBack} variant="prominent" titleAlign="left" />
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
