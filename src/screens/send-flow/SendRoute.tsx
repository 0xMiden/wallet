import React from 'react';

import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { isFeatureBlocked } from 'components/FeatureUnavailable';
import { useFeatureAvailability } from 'lib/remote-config/use-feature-availability';

import { RouteOptions, RouteOptionsProps } from './Route';
import { SendStepLayout } from './SendStepLayout';
import { useAgglayerEligibility } from './useAgglayerEligibility';

export interface SendRouteProps extends Omit<
  RouteOptionsProps,
  'slowStatus' | 'fastAvailability' | 'slowAvailability'
> {
  faucetId: string;
  onBack: () => void;
  onConfirm: () => void;
}

/** The send flow's cross-chain route step, on the shared step frame. */
export const SendRoute: React.FC<SendRouteProps> = ({ faucetId, onBack, onConfirm, ...options }) => {
  const { t } = useTranslation();
  const slowStatus = useAgglayerEligibility(faucetId);
  const fastAvailability = useFeatureAvailability('fastBridgeOut');
  const slowAvailability = useFeatureAvailability('bridgeOut');
  // The USDCx burn reads no remote bridge config, so the Fast and Slow features cannot block it.
  const confirmBlocked = (() => {
    switch (options.route) {
      case 'epoch':
        return isFeatureBlocked(fastAvailability);
      case 'agglayer':
        return isFeatureBlocked(slowAvailability) || slowStatus !== 'allowed';
      case 'usdcx':
      default:
        return !options.usdcxAvailable;
    }
  })();

  return (
    <SendStepLayout
      title={t('route')}
      onBack={onBack}
      footer={
        <Button
          title={t('confirm')}
          variant={ButtonVariant.Primary}
          accent="send"
          onClick={onConfirm}
          disabled={confirmBlocked}
          data-testid="bridge-route-confirm"
          className="w-full max-w-none"
        />
      }
    >
      <RouteOptions
        {...options}
        slowStatus={slowStatus}
        fastAvailability={fastAvailability}
        slowAvailability={slowAvailability}
        accent="send"
      />
    </SendStepLayout>
  );
};
