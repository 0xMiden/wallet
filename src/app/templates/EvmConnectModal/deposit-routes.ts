/**
 * The routes of the Deposit flow and their order: the relay routes (Agglayer, Epoch, Circle xReserve) and NEAR
 * Intents. The relay screen and the NEAR Intents flow use these to fill one route sheet ("Choose a route").
 */
import BigNumber from 'bignumber.js';

import { usdcxArrivalKey } from 'lib/usdcx/constant';
import type { DepositRouteOption } from 'screens/deposit-flow/DepositRouteSheet';
import type { DepositAmountValue } from 'screens/deposit-flow/types';

import type { RelayRoute } from './relay-deposit-record';

/** The id of the NEAR Intents route in the route sheet (the mock-up's route `N`). */
export const NEAR_ROUTE_ID = 'near-intents';

/**
 * The relay routes by cost, the mock-up's order (`routeRowsV`, `cost = { A: 1, E: 2 }`): Agglayer takes no bridge fee,
 * so it receives most. Circle is not in the mock-up's sheet; its fee model has no bridge fee for Circle, so it comes
 * before Epoch.
 */
export const RELAY_ROUTES_BY_COST: readonly RelayRoute[] = ['agglayer', 'usdcx', 'epoch'];
/** The mock-up's speed rank (`rank = { E: 1, A: 3 }`), for two routes whose stated times are the same. Circle last. */
export const RELAY_ROUTES_BY_RANK: readonly RelayRoute[] = ['epoch', 'agglayer', 'usdcx'];
/** The mock-up's speed rank of every route (`rank = { E: 1, N: 2, A: 3 }`), Circle last. */
const ROUTES_BY_RANK: readonly string[] = ['epoch', NEAR_ROUTE_ID, 'agglayer', 'usdcx'];
/** The minutes that each arrival text of the wallet states, so the route sheet can name the fastest route. */
export const STATED_MINUTES = {
  depositFlowArrivesAgglayer: 30,
  depositFlowArrivesEpoch: 2,
  usdcxArrival: 2,
  usdcxArrivalArc: 1,
  // "2 to 3 minutes" (the mock-up's `TIME.N`): the upper end.
  depositFlowNearArrives: 3
} satisfies Record<string, number>;

/** The i18n key of a route's arrival time: Circle's is the one that the Circle screens show for the chain. */
export function arrivalKeyOf(route: RelayRoute, chainId: number): keyof typeof STATED_MINUTES {
  switch (route) {
    case 'agglayer':
      return 'depositFlowArrivesAgglayer';
    case 'epoch':
      return 'depositFlowArrivesEpoch';
    case 'usdcx':
      return usdcxArrivalKey(chainId);
  }
}

/** The i18n key of a relay route's name. */
export function relayRouteNameKey(route: RelayRoute): string {
  switch (route) {
    case 'agglayer':
      return 'depositFlowRouteAgglayer';
    case 'epoch':
      return 'depositFlowRouteEpoch';
    case 'usdcx':
      return 'depositFlowRouteCircle';
  }
}

/** The relay route of a route sheet id, or undefined for another id. */
export function relayRouteOfId(id: string): RelayRoute | undefined {
  return RELAY_ROUTES_BY_COST.find(route => route === id);
}

/** The minutes that the wallet states for a route id. An unknown id is the slowest. */
function routeMinutes(id: string, chainId: number): number {
  if (id === NEAR_ROUTE_ID) return STATED_MINUTES.depositFlowNearArrives;
  const relay = relayRouteOfId(id);
  return relay === undefined ? Number.MAX_SAFE_INTEGER : STATED_MINUTES[arrivalKeyOf(relay, chainId)];
}

function rankOf(id: string): number {
  const index = ROUTES_BY_RANK.indexOf(id);
  return index < 0 ? ROUTES_BY_RANK.length : index;
}

/** An amount in whole token units. */
function wholeUnits(value: DepositAmountValue): BigNumber {
  return value.decimals === undefined
    ? new BigNumber(value.amount)
    : new BigNumber(value.amount.toString()).shiftedBy(-value.decimals);
}

/**
 * The rows with their tags set again: the rows go by what they receive, most first (a row with no known amount after
 * the rows with one, and the given order on a tie), "Most received" is the first row, "Fastest" is the route with the
 * shortest stated time (the mock-up's rank on a tie), and a row with a known amount says how much less it receives than
 * the first row.
 */
export function rankRouteOptions(rows: readonly DepositRouteOption[], chainId: number): DepositRouteOption[] {
  const ordered = rows
    .map((row, index) => ({ row, index, value: row.received === undefined ? undefined : wholeUnits(row.received) }))
    .sort((a, b) => {
      if (a.value !== undefined && b.value !== undefined && !a.value.eq(b.value)) return a.value.gt(b.value) ? -1 : 1;
      if ((a.value === undefined) !== (b.value === undefined)) return a.value === undefined ? 1 : -1;
      return a.index - b.index;
    });
  const fastest = [...rows].sort(
    (a, b) => routeMinutes(a.id, chainId) - routeMinutes(b.id, chainId) || rankOf(a.id) - rankOf(b.id)
  )[0]?.id;
  const top = ordered[0]?.value;
  return ordered.map(({ row, value }, index) => {
    const gap = top !== undefined && value !== undefined ? top.minus(value) : undefined;
    const less: DepositAmountValue | undefined = gap !== undefined && gap.gt(0) ? { amount: gap.toFixed() } : undefined;
    return { ...row, best: index === 0, fastest: row.id === fastest, less };
  });
}

/**
 * The route sheet's rows: the relay rows as the relay screen orders them, and the routes of another flow (NEAR
 * Intents). With no other route the relay rows are returned as they are; else every row is ranked again.
 */
export function mergeRouteOptions(
  relayRows: readonly DepositRouteOption[],
  others: readonly DepositRouteOption[] | undefined,
  chainId: number
): readonly DepositRouteOption[] {
  if (others === undefined || others.length === 0) return relayRows;
  return rankRouteOptions([...relayRows, ...others], chainId);
}
