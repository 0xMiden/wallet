import type { TrackedPositionState } from '../../../src/lib/miden/front/use-tracked-position';

// 2.5 IETH (8 decimals) is held; the quote is ETH at $1,234.5678, so the position is worth $3,086.42.
const pnl = new URLSearchParams(window.location.search).get('pnl');
const quantity = 250_000_000n;
const trackingSince = Date.UTC(2026, 10, 20);
const STATES: Record<string, TrackedPositionState> = {
  gain: { position: { quantity, costMicro: 2_500_000_000n }, trackingSince },
  loss: { position: { quantity, costMicro: 3_600_000_000n }, trackingSince },
  incomplete: { position: { quantity, costMicro: undefined }, trackingSince }
};

export const useTrackedPosition = (): TrackedPositionState | undefined => (pnl ? STATES[pnl] : undefined);
