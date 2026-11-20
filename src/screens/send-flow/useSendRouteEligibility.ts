import { isFeatureBlocked } from 'components/FeatureUnavailable';
import type { FeatureAvailability } from 'lib/remote-config/availability';
import { useBridgeConfigSnapshot, useFeatureAvailability } from 'lib/remote-config/use-feature-availability';

import { sendTokenRoutes } from './send-token-routes';
import { BridgeRoute } from './types';
import { useAgglayerEligibility } from './useAgglayerEligibility';

/** The route-step admission check, shared by compact Confirm and Command Review/Enter. */
export function useSendRouteEligibility(
  faucetId: string,
  destinationChainId: number | undefined,
  route: BridgeRoute,
  usdcxAvailable: boolean,
  active: boolean
) {
  const snapshot = useBridgeConfigSnapshot();
  const bridges = Object.values(snapshot.config?.supportedEvmChains ?? {}).find(
    chain => chain.chainId === destinationChainId
  )?.bridges;
  const routes = destinationChainId === undefined ? undefined : sendTokenRoutes(snapshot, faucetId, destinationChainId);
  const slowStatus = useAgglayerEligibility(faucetId, destinationChainId, active);
  const fastFeatureAvailability = useFeatureAvailability('fastBridgeOut', {
    chainId: destinationChainId,
    hold: active
  });
  // An available feature without a route for this faucet is not configured, not an open route.
  const fastAvailability: FeatureAvailability =
    routes?.epoch === false && fastFeatureAvailability.state === 'available'
      ? {
          state: 'unavailable',
          reason: 'not-configured',
          detail: 'No Epoch output for this faucet on the selected chain'
        }
      : fastFeatureAvailability;
  const slowFeatureAvailability = useFeatureAvailability('bridgeOut', {
    chainId: destinationChainId,
    hold: active
  });
  const slowAvailability: FeatureAvailability =
    routes?.agglayer === false && slowFeatureAvailability.state === 'available'
      ? { state: 'unavailable', reason: 'not-configured', detail: 'No AggLayer withdrawal on the selected chain' }
      : slowFeatureAvailability;
  const blocked =
    !active ||
    !faucetId ||
    destinationChainId === undefined ||
    (route !== 'usdcx' && !routes?.[route]) ||
    (route === 'epoch'
      ? isFeatureBlocked(fastAvailability)
      : route === 'agglayer'
        ? isFeatureBlocked(slowAvailability) || slowStatus !== 'allowed'
        : !usdcxAvailable);

  return {
    blocked,
    slowStatus,
    fastAvailability,
    slowAvailability,
    showFastRoute: bridges?.epoch !== undefined,
    showSlowRoute: bridges?.agglayer !== undefined
  };
}

export type SendRouteEligibility = ReturnType<typeof useSendRouteEligibility>;
