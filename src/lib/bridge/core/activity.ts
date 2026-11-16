import type { BridgeActivity } from './models';
import { parseReceiptRoute } from './receipt-route';
import type { BridgeRoute } from './routes';

export function createActivity(route: BridgeRoute, amount: string): BridgeActivity {
  const now = Date.now();
  return {
    id: `act-${now.toString(36)}`,
    mode: route.mode,
    provider: route.provider,
    routeId: route.id,
    environment: route.recovery.network,
    routeSnapshot: structuredClone(route),
    status: 'signature',
    amount,
    asset: route.source.symbol,
    updatedAt: now,
    sourceTxAt: now
  };
}

export function activityRoute(activity: BridgeActivity): BridgeRoute | undefined {
  const route = parseReceiptRoute(activity.routeSnapshot);
  return route && route.provider === activity.provider && route.mode === activity.mode ? route : undefined;
}

export function activityStartedAt(activity: BridgeActivity): number {
  if (activity.sourceTxAt) return activity.sourceTxAt;
  const match = /^act-([0-9a-z]+)$/.exec(activity.id);
  const fromId = match ? parseInt(match[1] ?? '', 36) : NaN;
  return Number.isFinite(fromId) && fromId > 1_600_000_000_000 ? fromId : activity.updatedAt;
}

export function stampLegTimes<T extends BridgeActivity>(activity: T): T {
  let next = activity;
  if (next.sourceTxHash && !next.sourceTxAt) next = { ...next, sourceTxAt: activityStartedAt(next) };
  if (
    (next.destinationTxHash || (next.mode === 'receive' && next.midenTxId) || next.claimTxHash) &&
    !next.destinationTxAt
  ) {
    next = { ...next, destinationTxAt: Date.now() };
  }
  return next;
}
