import React, { useEffect } from 'react';

import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { isFeatureBlocked } from 'components/FeatureUnavailable';
import { useFeatureAvailability } from 'lib/remote-config/use-feature-availability';

import { NearIntentsRouteCard, RouteOptions, RouteOptionsProps } from './Route';
import { SendStepLayout } from './SendStepLayout';
import { useAgglayerEligibility } from './useAgglayerEligibility';
import { useNearIntentsSendQuote } from './useNearIntentsSendQuote';

export interface SendRouteProps extends Omit<
  RouteOptionsProps,
  'slowStatus' | 'fastAvailability' | 'slowAvailability' | 'nearIntentsCard' | 'bridgeRoutesAvailable'
> {
  faucetId: string;
  destinationChainId?: number;
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
  destinationChainId,
  onBack,
  onConfirm,
  nearIntents,
  bridgeRoutesAvailable,
  ...options
}) => {
  const { t } = useTranslation();
  const slowStatus = useAgglayerEligibility(faucetId, destinationChainId);
  const fastAvailability = useFeatureAvailability('fastBridgeOut', { chainId: destinationChainId });
  const slowAvailability = useFeatureAvailability('bridgeOut', { chainId: destinationChainId });
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

  // The USDCx burn reads no remote bridge config, so the Fast and Slow features cannot block it. NEAR Intents
  // reads its own config: the quote is ready only when that config, the pair and the quote are there.
  const confirmBlocked = (() => {
    switch (route) {
      case 'near-intents':
        return nearIntents === undefined || nearIntentsQuote.status !== 'ready';
      case 'epoch':
        return !bridgeRoutesAvailable || isFeatureBlocked(fastAvailability);
      case 'agglayer':
        return !bridgeRoutesAvailable || isFeatureBlocked(slowAvailability) || slowStatus !== 'allowed';
      case 'usdcx':
      default:
        return !bridgeRoutesAvailable || !options.usdcxAvailable;
    }
  })();

  return (
    <SendStepLayout
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
        slowStatus={slowStatus}
        fastFeature="fastBridgeOut"
        fastAvailability={fastAvailability}
        slowFeature="bridgeOut"
        slowAvailability={slowAvailability}
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
