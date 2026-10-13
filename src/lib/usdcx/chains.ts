import { formatUnits } from 'viem';

import { type BridgeConfigSnapshot, getBridgeConfigSnapshot } from 'lib/remote-config/runtime';
import type { UsdcxConfig } from 'lib/remote-config/schema';
import { BridgeConfigUnavailableError } from 'lib/remote-config/values';

import { USDCX_DECIMALS } from './constant';
import {
  buildUsdcxRoutes,
  minimumPayout,
  type UsdcxDestination,
  type UsdcxExecutorSource,
  type UsdcxRoutes,
  type UsdcxSourceChain,
  type UsdcxXReserveSource
} from './routes';

// The USDCx contracts and Circle services come from the network's bridge config (`usdcx` in
// 0xMiden/wallet-config), never a compiled table. Every getter here reads this realm's snapshot synchronously, so a
// path that runs without a user action first awaits `initBridgeConfig()`.

// One build per accepted document: the snapshot keeps its config object until a new document lands.
const built = new WeakMap<UsdcxConfig, UsdcxRoutes>();

const NO_SOURCES: ReadonlyMap<number, UsdcxSourceChain> = new Map();
const NO_DESTINATIONS: ReadonlyMap<number, UsdcxDestination> = new Map();

/** The USDCx routes of the snapshot's document, or null while it lists none. */
export function selectUsdcxRoutes(s: BridgeConfigSnapshot): UsdcxRoutes | null {
  const config = s.config?.usdcx;
  if (!config) return null;
  const known = built.get(config);
  if (known) return known;
  const routes = buildUsdcxRoutes(config);
  built.set(config, routes);
  return routes;
}

/** The USDCx routes of the effective network, or null while its document lists none. */
export function getUsdcxRoutes(): UsdcxRoutes | null {
  return selectUsdcxRoutes(getBridgeConfigSnapshot());
}

/** Every chain a bridge-in can start from, keyed by EVM chain id. Empty while the document lists none. */
export function getUsdcxSourceChains(): ReadonlyMap<number, UsdcxSourceChain> {
  return getUsdcxRoutes()?.sources ?? NO_SOURCES;
}

/** Every chain a burn can pay out to, keyed by EVM chain id. Empty while the document lists none. */
export function getUsdcxDestinations(): ReadonlyMap<number, UsdcxDestination> {
  return getUsdcxRoutes()?.destinations ?? NO_DESTINATIONS;
}

/** Circle's remote-domain id for Miden. A deposit to an unregistered domain reverts with `RemoteDomainNotRegistered`. */
export function getUsdcxMidenDomain(): number {
  const routes = getUsdcxRoutes();
  if (!routes) throw new BridgeConfigUnavailableError('usdcx.midenDomain');
  return routes.midenDomain;
}

export function getUsdcxSourceChain(chainId: number): UsdcxSourceChain {
  const source = getUsdcxSourceChains().get(chainId);
  if (!source) throw new Error(`USDCx bridge-in is not configured for chain ${chainId}`);
  return source;
}

/** The source entry of a chain with a local xReserve; throws for an executor source or an unknown chain. */
export function getUsdcxXReserveSource(chainId: number): UsdcxXReserveSource {
  const source = getUsdcxSourceChain(chainId);
  if (source.route !== 'xreserve') throw new Error(`USDCx chain ${chainId} has no local xReserve`);
  return source;
}

/** The source entry of a chain that reaches Arc's xReserve through the executor; throws otherwise. */
export function getUsdcxExecutorSource(chainId: number): UsdcxExecutorSource {
  const source = getUsdcxSourceChain(chainId);
  if (source.route !== 'cctp-executor') throw new Error(`USDCx chain ${chainId} is not an executor source`);
  return source;
}

/** Whether `chainId` deposits through Circle's executor on Arc. Unknown chains read as false. */
export function isUsdcxExecutorSource(chainId: number | undefined): boolean {
  return chainId !== undefined && getUsdcxSourceChains().get(chainId)?.route === 'cctp-executor';
}

export function getUsdcxDestination(chainId: number): UsdcxDestination {
  const entry = getUsdcxDestinations().get(chainId);
  if (!entry) throw new Error(`USDCx withdrawal is not configured for chain ${chainId}`);
  return entry;
}

/** The source chains the effective network offers, in the document's order. */
export function listUsdcxSourceChains(): UsdcxSourceChain[] {
  return [...getUsdcxSourceChains().values()];
}

/** The destinations the effective network offers, in the document's order. */
export function listUsdcxDestinations(): UsdcxDestination[] {
  return [...getUsdcxDestinations().values()];
}

/**
 * The least USDC a burn of `amount` is expected to pay out on `chainId`: the amount minus the chain's fee allowance.
 * It is not positive when the allowance takes the whole amount. Any unrelated credit meets such a floor, so the wallet
 * refuses that burn (`usdcxPayoutFeeShortfall`) and never confirms an older one by balance.
 */
export function minimumUsdcxPayout(chainId: number, amount: bigint): bigint {
  return minimumPayout(getUsdcxDestinations(), chainId, amount);
}

/**
 * The fee allowance a burn of `amount` to `chainId` fails to exceed, in USDCx, and the chain's name, as the refusal
 * names them; undefined once the amount exceeds it, and for no amount or an unknown chain, which other checks refuse.
 */
export function usdcxPayoutFeeShortfall(
  chainId: number,
  amount: bigint
): { amount: string; network: string } | undefined {
  const destination = getUsdcxDestinations().get(chainId);
  if (!destination || amount <= 0n || minimumUsdcxPayout(chainId, amount) > 0n) return undefined;
  return { amount: formatUnits(destination.payoutFeeAllowance, USDCX_DECIMALS), network: destination.chain.name };
}
