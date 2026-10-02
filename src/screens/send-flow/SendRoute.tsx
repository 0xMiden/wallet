import React from 'react';

import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';

import { RouteOptions, RouteOptionsProps } from './Route';
import { SendStepLayout } from './SendStepLayout';
import { useAgglayerEligibility } from './useAgglayerEligibility';

export interface SendRouteProps extends Omit<RouteOptionsProps, 'slowStatus'> {
  faucetId: string;
  onBack: () => void;
  onConfirm: () => void;
}

/** The send flow's cross-chain route step, on the shared step frame. */
export const SendRoute: React.FC<SendRouteProps> = ({ faucetId, onBack, onConfirm, ...options }) => {
  const { t } = useTranslation();
  const slowStatus = useAgglayerEligibility(faucetId);

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
          disabled={options.route === 'agglayer' && slowStatus !== 'allowed'}
          data-testid="bridge-route-confirm"
          className="w-full max-w-none"
        />
      }
    >
      <RouteOptions {...options} slowStatus={slowStatus} accent="send" />
    </SendStepLayout>
  );
};
