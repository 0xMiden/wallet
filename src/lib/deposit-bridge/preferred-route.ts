import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';
import type { BridgeRoute } from 'screens/send-flow/types';

import { availableRoutes, getDepositToken, isDepositTokenId, type DepositTokenId } from './tokens';

/**
 * Per-address, per-token route the user picked on the Receive Cross-chain tab.
 *
 * The route is chosen BEFORE the deposit is funded, and the bridge itself only
 * runs once the money lands — which can be minutes later, in another popup
 * session or after a restart. So the choice has to outlive the page that made
 * it; in-memory state would be gone by the time it mattered.
 */

const STORAGE_KEY = 'deposit_preferred_routes_v1';

/** Keyed `${lowercasedAddress}:${token}`, matching the watermark store. */
export type DepositPreferredRouteStore = Record<string, BridgeRoute>;

export function preferredRouteKey(address: string, token: DepositTokenId): string {
  return `${address.trim().toLowerCase()}:${token}`;
}

function isBridgeRoute(value: unknown): value is BridgeRoute {
  return value === 'epoch' || value === 'agglayer';
}

/**
 * Read the whole store, discarding anything unusable. A stored route is only
 * honoured while the token can still take it: the route table is code, and a
 * release that drops a route must not leave a saved preference selecting it.
 */
export async function readPreferredRoutes(): Promise<DepositPreferredRouteStore> {
  const stored = await fetchFromStorage<unknown>(STORAGE_KEY);
  if (!stored || typeof stored !== 'object') return {};
  const out: DepositPreferredRouteStore = {};
  for (const key of Object.keys(stored)) {
    const [address, token] = key.split(':');
    if (!address || !isDepositTokenId(token)) continue;
    const route: unknown = Reflect.get(stored, key);
    if (!isBridgeRoute(route) || !availableRoutes(token).includes(route)) continue;
    out[key] = route;
  }
  return out;
}

/** The saved route for this address+token, or the token's default when there is none. */
export async function readPreferredRoute(address: string, token: DepositTokenId): Promise<BridgeRoute> {
  const store = await readPreferredRoutes();
  return store[preferredRouteKey(address, token)] ?? getDepositToken(token).route;
}

/** Records the choice. A route the token cannot take is ignored rather than stored. */
export async function writePreferredRoute(address: string, token: DepositTokenId, route: BridgeRoute): Promise<void> {
  if (!availableRoutes(token).includes(route)) return;
  const store = await readPreferredRoutes();
  await putToStorage(STORAGE_KEY, { ...store, [preferredRouteKey(address, token)]: route });
}
