import { Endpoint, MidenClient, NetworkId } from '@miden-sdk/miden-sdk/lazy';

import {
  getEffectiveExplorerUrl,
  getEffectiveGuardianUrl,
  getEffectiveNetworkName,
  getEffectiveRpcUrl
} from 'lib/miden-chain/effective-endpoints';
import {
  DEFAULT_NETWORK,
  GUARDIAN_OPTIONS,
  MIDEN_EXPLORER_ENDPOINTS,
  MIDEN_GUARDIAN_ENDPOINTS,
  MIDEN_NETWORK_NAME,
  MIDEN_NOTE_TRANSPORT_LAYER_ENDPOINTS
} from 'lib/miden-chain/networks-config';
import type { ResolvedGuardianOption } from 'lib/miden-chain/networks-config';

export * from './networks-config';

export function getExplorerTxUrl(txHash: string, network: string = getEffectiveNetworkName()): string | undefined {
  const base =
    network === getEffectiveNetworkName() ? getEffectiveExplorerUrl() : MIDEN_EXPLORER_ENDPOINTS.get(network);
  return base ? `${base}/tx/${txHash}` : undefined;
}

/**
 * Build-time override for the note-transport URL, independent of the chain
 * RPC's network. Lets developers point a testnet-RPC build at a local
 * transport instance (e.g. `~/miden/miden-note-transport` run via `cargo run`)
 * for iteration without having to deploy a fix to `transport.miden.io`.
 *
 * Set via `MIDEN_NOTE_TRANSPORT_URL=http://localhost:57292 yarn build:...`.
 * Empty string = use the per-network default from the map above.
 */
const MIDEN_NOTE_TRANSPORT_URL_OVERRIDE = process.env.MIDEN_NOTE_TRANSPORT_URL || '';

export function getNoteTransportUrl(network: string): string | undefined {
  return MIDEN_NOTE_TRANSPORT_URL_OVERRIDE || MIDEN_NOTE_TRANSPORT_LAYER_ENDPOINTS.get(network);
}

/**
 * Resolve GUARDIAN_OPTIONS to the providers that run a Guardian on `network`,
 * each flattened to its endpoint on that network (in GUARDIAN_OPTIONS order).
 * Single source of truth so the create picker and import presets can't drift.
 */
export function getGuardianOptionsForNetwork(
  network: MIDEN_NETWORK_NAME = getEffectiveNetworkName()
): ResolvedGuardianOption[] {
  const options = GUARDIAN_OPTIONS.filter(o => o.endpoint.has(network)).map(o => ({
    id: o.id,
    name: o.name,
    operatedBy: o.operatedBy,
    location: o.location,
    endpoint: o.endpoint.get(network)!
  }));

  // Localnet E2E only: expose a second guardian instance (container at :3001).
  // Never visible in production — gated on MIDEN_E2E_TEST.
  if (network === MIDEN_NETWORK_NAME.LOCALNET && process.env.MIDEN_E2E_TEST === 'true') {
    options.push({
      id: 'open-zeppelin-b',
      name: 'OpenZeppelin B',
      operatedBy: 'Open-Zeppelin',
      location: 'US-EAST',
      endpoint: 'http://localhost:3001'
    });
  }

  // Developer override: a custom guardian URL is offered as an extra selectable option.
  const customGuardian = getEffectiveGuardianUrl();
  if (customGuardian && !options.some(o => o.endpoint === customGuardian)) {
    options.push({
      id: 'custom',
      name: 'Custom',
      operatedBy: 'Custom',
      location: '—',
      endpoint: customGuardian
    });
  }

  return options;
}

/**
 * Default Guardian endpoint for the active network, or '' when the network has
 * no configured Guardian (e.g. mainnet). Intentionally does NOT fall
 * back to the staging endpoint: a mainnet build silently signing Guardian
 * requests against staging would be a real security problem. Safe to use as a
 * UI default/placeholder; Guardian *operations* should call
 * `getDefaultGuardianEndpoint()` so an unsupported network fails loudly.
 */
export const DEFAULT_GUARDIAN_ENDPOINT = MIDEN_GUARDIAN_ENDPOINTS.get(DEFAULT_NETWORK)?.[0] ?? '';

/**
 * Whether the active network has at least one configured Guardian endpoint.
 */
export const IS_GUARDIAN_SUPPORTED = (MIDEN_GUARDIAN_ENDPOINTS.get(DEFAULT_NETWORK)?.length ?? 0) > 0;

/**
 * Resolve the default Guardian endpoint for the active network, throwing a
 * descriptive error on networks without a configured Guardian. Use this at
 * Guardian account create/import entry points so the feature refuses to operate
 * (rather than silently targeting the wrong backend) on an unsupported network.
 */
export function getDefaultGuardianEndpoint(): string {
  const custom = getEffectiveGuardianUrl();
  if (custom) return custom;
  const network = getEffectiveNetworkName();
  const endpoints = MIDEN_GUARDIAN_ENDPOINTS.get(network);
  if (!endpoints || endpoints.length === 0) {
    throw new Error(`Guardian is not available on network "${network}": no Guardian endpoint is configured.`);
  }
  return endpoints[0]!;
}

/**
 * Returns the SDK NetworkId for the effective network (build default, unless
 * a developer endpoint override is active).
 */
export function getNetworkId(): NetworkId {
  const network: string = getEffectiveNetworkName();
  switch (network) {
    /* c8 ignore start */
    case MIDEN_NETWORK_NAME.MAINNET:
      return NetworkId.mainnet();
    case MIDEN_NETWORK_NAME.DEVNET:
      return NetworkId.devnet();
    /* c8 ignore stop */
    case MIDEN_NETWORK_NAME.TESTNET:
    case MIDEN_NETWORK_NAME.LOCALNET:
    default:
      return NetworkId.testnet();
  }
}

/**
 * Returns the SDK Endpoint for the effective network (build default, unless
 * a developer endpoint override is active).
 *
 * NOTE: this constructs a wasm-bindgen-backed `Endpoint` instance and
 * therefore requires the SDK's WASM module to be loaded on this thread.
 * Page-side callers should `await ensureSdkWasmReady()` first.
 */
export function getRpcEndpoint(): Endpoint {
  return new Endpoint(getEffectiveRpcUrl());
}

/**
 * Resolves once the SDK's WASM module is initialized on the current thread,
 * so subsequent `new Endpoint(...)` / `new RpcClient(...)` calls are safe.
 *
 * Delegates to `MidenClient.ready()` (0.14.4+), which is idempotent and
 * shared across callers.
 */
export function ensureSdkWasmReady(): Promise<void> {
  return MidenClient.ready();
}
