import { assetKey, sameAsset, type BridgeAsset } from 'lib/bridge/core/assets';
import type { BridgeRoute } from 'lib/bridge/core/routes';

export type BridgeSide = 'source' | 'destination';
export interface TokenChoice {
  asset: BridgeAsset;
  route: BridgeRoute;
}

// The wallet cannot quote an Epoch receive.
const isEpochReceive = (route: BridgeRoute) => route.provider === 'epoch' && route.mode === 'receive';
const otherSide = (side: BridgeSide): BridgeSide => (side === 'source' ? 'destination' : 'source');

export function defaultBridgeRoute(routes: readonly BridgeRoute[]): BridgeRoute | undefined {
  return routes.find(route => !isEpochReceive(route)) ?? routes[0];
}

function preferredRoute(routes: readonly BridgeRoute[], current: BridgeRoute): BridgeRoute | undefined {
  return (
    routes.find(route => route.provider === current.provider && !isEpochReceive(route)) ?? defaultBridgeRoute(routes)
  );
}

export function externalSide(route: BridgeRoute): BridgeSide {
  return route.mode === 'receive' ? 'source' : 'destination';
}

export function networkChoices(routes: readonly BridgeRoute[]): string[] {
  return [...new Set(routes.map(route => route[externalSide(route)].network))];
}

export function routeForNetwork(
  routes: readonly BridgeRoute[],
  current: BridgeRoute,
  network: string
): BridgeRoute | undefined {
  const external = externalSide(current);
  if (network === current[external].network) return current;
  const miden = otherSide(external);
  const onNetwork = routes.filter(route => route[external].network === network);
  return (
    preferredRoute(
      onNetwork.filter(route => sameAsset(route[miden], current[miden])),
      current
    ) ??
    preferredRoute(
      onNetwork.filter(route => route[external].symbol === current[external].symbol),
      current
    ) ??
    defaultBridgeRoute(onNetwork)
  );
}

export function tokenChoices(routes: readonly BridgeRoute[], current: BridgeRoute, side: BridgeSide): TokenChoice[] {
  const external = externalSide(current);
  const byAsset = new Map<string, BridgeRoute[]>();
  for (const route of routes) {
    if (route[external].network !== current[external].network) continue;
    const key = assetKey(route[side]);
    byAsset.set(key, [...(byAsset.get(key) ?? []), route]);
  }
  const other = otherSide(side);
  return [...byAsset.values()].map(group => {
    // By id: route objects are derived afresh on every render.
    const route =
      group.find(item => item.id === current.id) ??
      preferredRoute(
        group.filter(item => sameAsset(item[other], current[other])),
        current
      ) ??
      preferredRoute(group, current)!;
    return { asset: route[side], route };
  });
}

export function pairRoutes(routes: readonly BridgeRoute[], current: BridgeRoute): BridgeRoute[] {
  return routes.filter(
    route => sameAsset(route.source, current.source) && sameAsset(route.destination, current.destination)
  );
}
