import React, { FC, useCallback, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { useBackWithFallback } from 'app/hooks/useBackWithFallback';
import { useCurrentGuardianEndpoint } from 'app/hooks/useCurrentGuardianEndpoint';
import PageLayout from 'app/layouts/PageLayout';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { sameGuardianEndpoint } from 'lib/settings/helpers';
import { navigate } from 'lib/woozie';
import { ChooseGuardianScreen } from 'screens/onboarding/common/ChooseGuardian';

const RotateGuardian: FC = () => {
  const { t } = useTranslation();
  const { endpoint: currentEndpoint } = useCurrentGuardianEndpoint();
  const [error, setError] = useState<string | null>(null);
  // Both entry points into the picker are Settings pages (Guardian Settings and
  // Keys), so a cold load belongs back in Settings rather than at the wallet home.
  const handleBack = useBackWithFallback('/settings');

  // Hardware/swipe back has to agree with the chevron: PageLayout's toolbar is
  // hidden here, and it was the only back-handler registration, so the mobile
  // catch-all sent the user to the wallet home instead of back to Settings.
  useMobileBackHandler(() => {
    handleBack();
    return true;
  }, [handleBack]);

  const handleSubmit = useCallback(
    ({ guardianEndpoint }: { guardianId: string; guardianEndpoint: string }) => {
      // Compared as endpoints, not exact strings: the picker hands over a normalized
      // custom URL but a built-in option's endpoint is a literal, and `currentEndpoint`
      // comes from storage or a default, so a host-case, explicit-default-port, or
      // trailing-slash difference alone must not read as a real change and persist a
      // second spelling.
      if (sameGuardianEndpoint(guardianEndpoint, currentEndpoint ?? '')) {
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
      {/* The picker draws the page: the shared header (back, "Choose your Guardian"), its
          explainer and cards in the body, and Continue pinned under it. */}
      <ChooseGuardianScreen
        onBack={handleBack}
        onSubmit={handleSubmit}
        currentEndpoint={currentEndpoint}
        allowCustomEndpoint
        error={error}
      />
    </PageLayout>
  );
};

export default RotateGuardian;
