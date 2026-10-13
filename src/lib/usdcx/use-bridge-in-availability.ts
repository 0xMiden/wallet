import type { FeatureAvailability } from 'lib/remote-config/availability';
import { type FeatureAvailabilityOptions, useAnyFeatureAvailability } from 'lib/remote-config/use-feature-availability';

/**
 * The availability of the Cross Chain entry: it opens a choice of the USDCx, Fast and Slow routes, so it is enabled
 * while the bridge config offers any of them.
 */
export function useBridgeInAvailability(options: FeatureAvailabilityOptions = {}): FeatureAvailability {
  return useAnyFeatureAvailability(['usdcxIn', 'fastBridgeIn', 'bridgeIn'], options);
}
