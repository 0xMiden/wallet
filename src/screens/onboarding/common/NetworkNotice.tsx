import React from 'react';

import { useTranslation } from 'react-i18next';

import { Button } from 'components/Button';
import { NetworkModePill } from 'components/NetworkModePill';
import { NetworkNoticeRows } from 'components/NetworkNoticeRows';
import { getTestNetworkNameKey } from 'lib/miden-chain/effective-endpoints';

import { OnboardingStepLayout } from './OnboardingStepLayout';

export interface NetworkNoticeScreenProps {
  onSubmit?: () => void;
}

/**
 * Onboarding notice shown after the first tap on Welcome, before the user
 * creates or restores a wallet. It names the effective network and lists the
 * three test-network facts above "I understand". On mainnet, which has no test
 * tokens, it renders nothing.
 */
export const NetworkNoticeScreen: React.FC<NetworkNoticeScreenProps> = ({ onSubmit }) => {
  const { t } = useTranslation();
  const networkKey = getTestNetworkNameKey();
  if (!networkKey) return null;
  const network = t(networkKey);

  return (
    <OnboardingStepLayout
      data-testid="onboarding-network-notice"
      eyebrow={<NetworkModePill data-testid="network-notice-pill" />}
      title={t('networkModeBanner', { network })}
      description={t('networkNoticeBody')}
      footer={
        <Button
          className="max-w-none"
          title={t('iUnderstand')}
          data-testid="onboarding-network-notice-acknowledge"
          onClick={onSubmit}
        />
      }
    >
      {/* The same three facts the network pill's sheet shows, so both say the same thing. */}
      <NetworkNoticeRows />
    </OnboardingStepLayout>
  );
};

export default NetworkNoticeScreen;
