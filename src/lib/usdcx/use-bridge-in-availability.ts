import { featureAvailability } from 'lib/remote-config/availability';
import type { FeatureAvailability } from 'lib/remote-config/availability';
import { getBridgeConfigSnapshot } from 'lib/remote-config/runtime';
import { type FeatureAvailabilityOptions, useAnyFeatureAvailability } from 'lib/remote-config/use-feature-availability';

export function isUsdcxDepositAvailable(): boolean {
  return featureAvailability('usdcxDeposit', getBridgeConfigSnapshot()).state === 'available';
}

/** False only when an accepted document's bridge-in availability is unavailable for `not-configured`. */
export function isBridgeInOfferedOnNetwork(hasDocument: boolean, availability: FeatureAvailability): boolean {
  return !(hasDocument && availability.state === 'unavailable' && availability.reason === 'not-configured');
}

export function useBridgeInAvailability({ hold = true }: FeatureAvailabilityOptions = {}): FeatureAvailability {
  return useAnyFeatureAvailability(['fastBridgeIn', 'bridgeIn', 'usdcxDeposit'], { hold });
}
