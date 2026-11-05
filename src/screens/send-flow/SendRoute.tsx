import React from 'react';

import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { isFeatureBlocked } from 'components/FeatureUnavailable';
import type { FeatureAvailability } from 'lib/remote-config/availability';
import { useBridgeConfigSnapshot, useFeatureAvailability } from 'lib/remote-config/use-feature-availability';

import { RouteOptions, RouteOptionsProps } from './Route';
import { sendTokenRoutes } from './send-token-routes';
import { SendStepLayout } from './SendStepLayout';
import { useAgglayerEligibility } from './useAgglayerEligibility';

export interface SendRouteProps extends Omit<
  RouteOptionsProps,
  'slowStatus' | 'fastAvailability' | 'slowAvailability'
> {
  faucetId: string;
  destinationChainId?: number;
  onBack: () => void;
  onConfirm: () => void;
}

/** The send flow's cross-chain route step, on the shared step frame. */
export const SendRoute: React.FC<SendRouteProps> = ({
  faucetId,
  destinationChainId,
  onBack,
  onConfirm,
  ...options
}) => {
  const { t } = useTranslation();
  const snapshot = useBridgeConfigSnapshot();
  const bridges = Object.values(snapshot.config?.supportedEvmChains ?? {}).find(
    chain => chain.chainId === destinationChainId
  )?.bridges;
  const routes = destinationChainId === undefined ? undefined : sendTokenRoutes(snapshot, faucetId, destinationChainId);
  const slowStatus = useAgglayerEligibility(faucetId, destinationChainId);
  const fastFeatureAvailability = useFeatureAvailability('fastBridgeOut', { chainId: destinationChainId });
  const fastAvailability: FeatureAvailability =
    routes?.epoch === false
      ? {
          state: 'unavailable',
          reason: 'not-configured',
          detail: 'No Epoch output for this faucet on the selected chain'
        }
      : fastFeatureAvailability;
  const slowAvailability = useFeatureAvailability('bridgeOut', { chainId: destinationChainId });
  // The Circle route has its own availability check.
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
        showFastRoute={bridges?.epoch !== undefined}
        showSlowRoute={bridges?.agglayer !== undefined}
        fastFeature="fastBridgeOut"
        fastAvailability={fastAvailability}
        slowFeature="bridgeOut"
        slowAvailability={slowAvailability}
        accent="send"
      />
    </SendStepLayout>
  );
};
