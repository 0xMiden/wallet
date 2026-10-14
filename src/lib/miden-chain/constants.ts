import { Endpoint, MidenClient, NetworkId } from '@miden-sdk/miden-sdk/lazy';

import {
  getEffectiveExplorerUrl,
  getEffectiveGuardianUrl,
  getEffectiveNetworkName,
  getEffectiveRpcUrl
} from 'lib/miden-chain/effective-endpoints';
import { getNetworkGuardianEndpoints, getNetworkGuardians } from 'lib/miden-chain/guardian-registry';
import {
  GUARDIAN_BRAND_NAME,
  MIDEN_EXPLORER_ENDPOINTS,
  MIDEN_NETWORK_NAME,
  MIDEN_NOTE_TRANSPORT_LAYER_ENDPOINTS
} from 'lib/miden-chain/networks-config';
import type { ResolvedGuardianOption } from 'lib/miden-chain/networks-config';
import { sameGuardianEndpoint } from 'lib/settings/helpers';
import { annotateCrash } from 'lib/telemetry/crash-diagnostics';

export * from './networks-config';

/** Effective explorer base for a network: the dev-settings override when it's the active network, else the build default. */
function getExplorerBaseUrl(network: string): string | undefined {
  return network === getEffectiveNetworkName() ? getEffectiveExplorerUrl() : MIDEN_EXPLORER_ENDPOINTS.get(network);
}

export function getExplorerTxUrl(txHash: string, network: string = getEffectiveNetworkName()): string | undefined {
  const base = getExplorerBaseUrl(network);
  return base ? `${base}/tx/${txHash}` : undefined;
}

export function getExplorerAccountUrl(
  address: string,
  network: string = getEffectiveNetworkName()
): string | undefined {
  const base = getExplorerBaseUrl(network);
  return base ? `${base}/account/${address}` : undefined;
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
 * The Guardian operators that are WALLET CONFIGURATION on `network`: the
 * `guardians` list of the network's accepted `0xMiden/wallet-config` document,
 * else the bundled GUARDIAN_OPTIONS (`getNetworkGuardians`), in list order, plus
 * the localnet E2E instance, a literal in this repo. Deliberately WITHOUT the
 * developer URL override that `getGuardianOptionsForNetwork` appends.
 *
 * The distinction is load-bearing for guardian drift reconciliation
 * (`lib/miden/guardian/operator-map`), which treats this set as a SECOND SOURCE
 * against an endpoint's own unauthenticated `GET /pubkey` self-report and lets a
 * member of it overwrite the endpoint stored on an account. That is only sound
 * while the set is bounded by the wallet's own configuration: the developer
 * override is persisted, user-settable settings state — the same category of
 * mutable value the corroboration exists to check — so a URL typed into dev
 * settings must not gain authority over an account that already verified against
 * a different endpoint.
 *
 * The config document counts as the wallet's own configuration here. It is not
 * signed: whoever can merge to that repository can name an operator in this
 * set, as they can already name the bridge contracts. The document is never
 * vault or settings state, and nothing a Guardian reports can reach it.
 */
export function getBuiltInGuardianOptionsForNetwork(
  network: MIDEN_NETWORK_NAME = getEffectiveNetworkName()
): ResolvedGuardianOption[] {
  const options = [...getNetworkGuardians(network)];

  // Localnet E2E only: expose a second guardian instance (container at :3001).
  // Never visible in production — gated on MIDEN_E2E_TEST.
  if (network === MIDEN_NETWORK_NAME.LOCALNET && process.env.MIDEN_E2E_TEST === 'true') {
    options.push({
      id: 'open-zeppelin-b',
      name: `${GUARDIAN_BRAND_NAME.openZeppelin} B`,
      operatedBy: GUARDIAN_BRAND_NAME.openZeppelin,
      location: 'US-EAST',
      endpoint: 'http://localhost:3001'
    });
  }

  return options;
}

/**
 * The providers that run a Guardian on `network`, each with its endpoint on
 * that network (in the order of {@link getBuiltInGuardianOptionsForNetwork}),
 * PLUS the developer guardian-URL override as an extra selectable option.
 * Single source of truth so the create picker and import presets can't drift —
 * both of them legitimately want to offer that override, which is why anything
 * that treats the operator list as evidence rather than as a menu reads
 * {@link getBuiltInGuardianOptionsForNetwork} instead.
 */
export function getGuardianOptionsForNetwork(
  network: MIDEN_NETWORK_NAME = getEffectiveNetworkName()
): ResolvedGuardianOption[] {
  const options = getBuiltInGuardianOptionsForNetwork(network);

  // Developer override: a custom guardian URL is offered as an extra selectable option.
  const customGuardian = getEffectiveGuardianUrl();
  if (customGuardian && !options.some(o => sameGuardianEndpoint(o.endpoint, customGuardian))) {
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
 * The endpoints of the operators that are wallet configuration on `network`,
 * in list order, so index 0 is the default operator. Without the localnet E2E
 * instance and without the developer override. Empty for a network with no
 * operator (mainnet today).
 */
export function getGuardianEndpointsForNetwork(network: string = getEffectiveNetworkName()): string[] {
  return getNetworkGuardianEndpoints(network);
}

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
  const endpoints = getNetworkGuardianEndpoints(network);
  if (endpoints.length === 0) {
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
    case MIDEN_NETWORK_NAME.LOCALNET:
      // The SDK exposes no localnet() constructor — localnet uses the 'mlcl'
      // bech32 HRP (ground truth: the node's faucet reports `mlcl1…` ids).
      // Without this branch LOCALNET fell through to testnet() and rendered
      // every address/faucet id under the wrong 'mtst1' prefix.
      return NetworkId.custom('mlcl');
    case MIDEN_NETWORK_NAME.TESTNET:
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
export async function ensureSdkWasmReady(): Promise<void> {
  try {
    await MidenClient.ready();
  } catch (error) {
    annotateCrash(error, { operation: 'sdk_initialize', stage: 'wasm_ready' });
    throw error;
  }
}
