import React, { useEffect } from 'react';

import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';

import { NearIntentsRouteCard, RouteOptions, RouteOptionsProps } from './Route';
import { SendStepLayout } from './SendStepLayout';
import { useNearIntentsSendQuote } from './useNearIntentsSendQuote';
import type { SendRouteEligibility } from './useSendRouteEligibility';

export interface SendRouteProps extends Omit<
  RouteOptionsProps,
  'slowStatus' | 'fastAvailability' | 'slowAvailability' | 'nearIntentsCard' | 'bridgeRoutesAvailable'
> {
  faucetId: string;
  eligibility: SendRouteEligibility;
  embedded?: boolean;
  onBack: () => void;
  onConfirm: () => void;
  /** Set when NEAR Intents offers the selected network. SendRoute then shows the NEAR Intents card and its quote. */
  nearIntents?: { chainId: string; recipient: string; amount?: bigint };
  /** False when no bridge route (Epoch, Agglayer, USDCx) serves the selected network; SendRoute then shows only the NEAR Intents card. */
  bridgeRoutesAvailable: boolean;
}

/** The send flow's cross-chain route step, on the shared step frame. */
export const SendRoute: React.FC<SendRouteProps> = ({
  faucetId,
  eligibility,
  embedded,
  onBack,
  onConfirm,
  nearIntents,
  bridgeRoutesAvailable,
  ...options
}) => {
  const { t } = useTranslation();
  const nearIntentsQuote = useNearIntentsSendQuote({
    chainId: nearIntents?.chainId,
    faucetId,
    amount: nearIntents?.amount,
    recipient: nearIntents?.recipient,
    enabled: nearIntents !== undefined
  });
  const { route, onRouteChange } = options;
  const nearIntentsOffered = nearIntents !== undefined;

  // With no bridge route, NEAR Intents is the only card, so it is the selected route.
  useEffect(() => {
    if (!bridgeRoutesAvailable && nearIntentsOffered && route !== 'near-intents') onRouteChange('near-intents');
  }, [bridgeRoutesAvailable, nearIntentsOffered, route, onRouteChange]);

  const confirmBlocked =
    route === 'near-intents'
      ? nearIntents === undefined || nearIntentsQuote.status !== 'ready'
      : !bridgeRoutesAvailable || eligibility.blocked;

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
          disabled={confirmBlocked}
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
        bridgeRoutesAvailable={bridgeRoutesAvailable}
        nearIntentsCard={
          nearIntents !== undefined ? (
            <NearIntentsRouteCard
              quote={nearIntentsQuote}
              selected={route === 'near-intents'}
              onSelect={() => onRouteChange('near-intents')}
              accent="send"
              hint={options.notice}
            />
          ) : undefined
        }
      />
    </SendStepLayout>
  );
};
