import React, { FC, useCallback, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { useBackWithFallback } from 'app/hooks/useBackWithFallback';
import { useCurrentGuardianEndpoint } from 'app/hooks/useCurrentGuardianEndpoint';
import PageLayout from 'app/layouts/PageLayout';
import { NavigationHeader } from 'components/NavigationHeader';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { sanitizeGuardianUrl } from 'lib/settings/helpers';
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
      // Sanitized on both sides: the picker hands over a normalized custom URL but
      // a built-in option's endpoint is a literal, and `currentEndpoint` comes from
      // storage or a default — so a difference in trailing slash alone read as a
      // real change and persisted a second spelling of the Guardian already in use.
      if (sanitizeGuardianUrl(guardianEndpoint) === sanitizeGuardianUrl(currentEndpoint ?? '')) {
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
      {/* No title: ChooseGuardianScreen renders its own h1 ("Choose your
          Guardian") plus the description and the "What is a Guardian?" link, and
          titling the header too gave the page two level-1 headings and two
          stacked titles. Hiding the picker's header instead would drop the
          description and the info affordance with it. */}
      <NavigationHeader onBack={handleBack} variant="prominent" titleAlign="left" />
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
