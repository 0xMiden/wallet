import type { TrackedPosition } from 'lib/prices/position-pnl';

export interface TrackedPositionState {
  position: TrackedPosition;
  trackingSince: number | undefined;
}

export function useTrackedPosition(
  _accountId: string,
  _network: string,
  _faucetId: string,
  _enabled: boolean
): TrackedPositionState | undefined {
  return undefined;
}
