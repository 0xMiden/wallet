import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import type { FeatureAvailability } from 'lib/remote-config/availability';
import { type FeatureAvailabilityOptions, useAnyFeatureAvailability } from 'lib/remote-config/use-feature-availability';

const AVAILABLE: FeatureAvailability = { state: 'available' };

/** The USDCx deposit needs only Circle xReserve, which the wallet uses on testnet. */
export function isUsdcxDepositAvailable(): boolean {
  return getEffectiveNetworkName() === 'testnet';
}

/**
 * The availability of the Cross Chain entry. The USDCx route does not read the remote bridge config, so the
 * entry stays enabled on testnet when the Epoch and Agglayer routes are both unavailable.
 */
export function useBridgeInAvailability({ hold = true }: FeatureAvailabilityOptions = {}): FeatureAvailability {
  const usdcx = isUsdcxDepositAvailable();
  const routes = useAnyFeatureAvailability(['fastBridgeIn', 'bridgeIn'], { hold: hold && !usdcx });
  return usdcx ? AVAILABLE : routes;
}
