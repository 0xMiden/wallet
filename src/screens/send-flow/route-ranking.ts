export type BridgeRouteRanking = 'best-value' | 'cheapest' | 'fastest';

export interface BridgeRouteMetrics {
  /** Comparable received value in the same asset/unit across this list, after provider fees. */
  receivedValue?: number;
  /** Total estimated bridge + network cost in USD, including gas paid separately. */
  totalCostUsd?: number;
  etaSeconds?: number;
  disabled?: boolean;
}

/** Reorder quotes without changing selection or mutating the provider's response. Unknowns sort last. */
export function rankBridgeRoutes<T extends BridgeRouteMetrics>(routes: readonly T[], ranking: BridgeRouteRanking): T[] {
  const metric = (route: T): number => {
    const value =
      ranking === 'best-value' ? route.receivedValue : ranking === 'cheapest' ? route.totalCostUsd : route.etaSeconds;
    return value !== undefined && Number.isFinite(value) && value >= 0
      ? ranking === 'best-value'
        ? -value
        : value
      : Infinity;
  };
  return [...routes].sort((left, right) => {
    if (Boolean(left.disabled) !== Boolean(right.disabled)) return left.disabled ? 1 : -1;
    const a = metric(left);
    const b = metric(right);
    return a === b ? 0 : a < b ? -1 : 1;
  });
}
