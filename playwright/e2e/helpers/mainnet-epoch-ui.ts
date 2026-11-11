import type { MainnetEpochCheckpoint } from './mainnet-epoch-checkpoint';
import type { OneClickRoundTripPlan } from './mainnet-one-click-plan';

export function planEpochRoundTrip(_state: MainnetEpochCheckpoint, _returnInput: bigint): OneClickRoundTripPlan | undefined {
  return undefined;
}
