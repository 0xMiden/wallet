import { featureAvailability } from 'lib/remote-config/availability';
import type { FeatureAvailability } from 'lib/remote-config/availability';
import { getBridgeConfigSnapshot } from 'lib/remote-config/runtime';
import { type FeatureAvailabilityOptions, useAnyFeatureAvailability } from 'lib/remote-config/use-feature-availability';

export function isUsdcxDepositAvailable(): boolean {
  return featureAvailability('usdcxDeposit', getBridgeConfigSnapshot()).state === 'available';
}

export function useBridgeInAvailability({ hold = true }: FeatureAvailabilityOptions = {}): FeatureAvailability {
  return useAnyFeatureAvailability(['fastBridgeIn', 'bridgeIn', 'usdcxDeposit'], { hold });
}
