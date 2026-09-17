import React from 'react';

import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';

import { RouteOptions, RouteOptionsProps } from './Route';
import { SendStepLayout } from './SendStepLayout';

export interface SendRouteProps extends RouteOptionsProps {
  confirmDisabled?: boolean;
  onBack: () => void;
  onConfirm: () => void;
}

/** The send flow's cross-chain route step, on the shared step frame. */
export const SendRoute: React.FC<SendRouteProps> = ({ confirmDisabled, onBack, onConfirm, ...options }) => {
  const { t } = useTranslation();

  return (
    <SendStepLayout
      title={t('route')}
      onBack={onBack}
      footer={
        <Button
          title={t('confirm')}
          variant={ButtonVariant.Primary}
          onClick={onConfirm}
          disabled={confirmDisabled}
          data-testid="bridge-route-confirm"
          className="w-full max-w-none rounded-full text-base font-semibold"
        />
      }
    >
      <RouteOptions {...options} accent="send" />
    </SendStepLayout>
  );
};
