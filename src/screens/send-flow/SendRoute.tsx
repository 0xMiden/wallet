import React from 'react';

import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';

import { RouteOptions, RouteOptionsProps } from './Route';
import { SendStepLayout } from './SendStepLayout';
import type { SendRouteEligibility } from './useSendRouteEligibility';

export interface SendRouteProps extends Omit<
  RouteOptionsProps,
  'slowStatus' | 'fastAvailability' | 'slowAvailability'
> {
  eligibility: SendRouteEligibility;
  embedded?: boolean;
  onBack: () => void;
  onConfirm: () => void;
}

/** The send flow's cross-chain route step, on the shared step frame. */
export const SendRoute: React.FC<SendRouteProps> = ({ eligibility, embedded, onBack, onConfirm, ...options }) => {
  const { t } = useTranslation();

  return (
    <SendStepLayout
      embedded={embedded}
      title={t('bridgeChooseRoute')}
      onBack={onBack}
      footer={
        <Button
          title={t('confirm')}
          variant={ButtonVariant.Primary}
          accent="send"
          onClick={onConfirm}
          disabled={eligibility.blocked}
          data-testid="bridge-route-confirm"
          className="w-full max-w-none"
        />
      }
    >
      <p className="text-body-sm text-muted">{t('bridgeRouteDescription')}</p>
      <RouteOptions
        {...options}
        slowStatus={eligibility.slowStatus}
        showFastRoute={eligibility.showFastRoute}
        showSlowRoute={eligibility.showSlowRoute}
        fastFeature="fastBridgeOut"
        fastAvailability={eligibility.fastAvailability}
        slowFeature="bridgeOut"
        slowAvailability={eligibility.slowAvailability}
        accent="send"
      />
    </SendStepLayout>
  );
};
