import { Endpoint, MidenClient, NetworkId } from '@miden-sdk/miden-sdk/lazy';

import { MidenNetwork } from 'lib/miden/types';
import type { GuardianOption } from 'lib/shared/types';

export const NETWORK_STORAGE_ID = 'network_id';

export enum MIDEN_NETWORK_NAME {
  MAINNET = 'mainnet',
  TESTNET = 'testnet',
  DEVNET = 'devnet',
  LOCALNET = 'localnet'
}

/**
 * Resolve a raw MIDEN_NETWORK build token to a wallet network enum.
 * The E2E harness builds the localnet bundle with MIDEN_NETWORK=localhost
 * (its network token), but the wallet enum key is 'localnet' — normalize it
 * so the localhost E2E build resolves endpoints instead of throwing.
 */
export function resolveNetworkName(raw: string | undefined): MIDEN_NETWORK_NAME {
  if (raw === 'localhost') return MIDEN_NETWORK_NAME.LOCALNET;
  const values = Object.values(MIDEN_NETWORK_NAME) as string[];
  return values.includes(raw ?? '') ? (raw as MIDEN_NETWORK_NAME) : MIDEN_NETWORK_NAME.TESTNET;
}

/**
 * The default network used throughout the app.
 * Driven by the MIDEN_NETWORK env variable at build time (default: testnet).
 * Use `yarn build:devnet` to build for devnet.
 */
export const DEFAULT_NETWORK = resolveNetworkName(process.env.MIDEN_NETWORK);

export enum MIDEN_TRANSPORT_LAYER_NAME {
  TESTNET = 'testnet',
  LOCALNET = 'localnet'
}

export const MIDEN_NETWORK_ENDPOINTS = new Map<string, string>([
  [MIDEN_NETWORK_NAME.MAINNET, 'https://api.miden.io'], // Placeholder
  [MIDEN_NETWORK_NAME.TESTNET, 'https://rpc.testnet.miden.io'],
  [MIDEN_NETWORK_NAME.DEVNET, 'https://rpc.devnet.miden.io'],
  [MIDEN_NETWORK_NAME.LOCALNET, 'http://localhost:57291']
]);

export const MIDEN_PROVING_ENDPOINTS = new Map<string, string>([
  [MIDEN_NETWORK_NAME.TESTNET, 'https://tx-prover.testnet.miden.io'],
  [MIDEN_NETWORK_NAME.DEVNET, 'https://tx-prover.devnet.miden.io'],
  // :50052, not :50051 — a locally-run guardian binds host :50051 for its gRPC,
  // so the localnet remote prover is published on :50052 to avoid the collision.
  [MIDEN_NETWORK_NAME.LOCALNET, 'http://localhost:50052']
]);

export const MIDEN_FAUCET_ENDPOINTS = new Map<string, string>([
  [MIDEN_NETWORK_NAME.TESTNET, 'https://faucet.testnet.miden.io'],
  [MIDEN_NETWORK_NAME.DEVNET, 'https://faucet.devnet.miden.io'],
  [MIDEN_NETWORK_NAME.LOCALNET, 'http://localhost:8080']
]);

export const MIDEN_NOTE_TRANSPORT_LAYER_ENDPOINTS = new Map<string, string>([
  [MIDEN_NETWORK_NAME.TESTNET, 'https://transport.miden.io'],
  [MIDEN_NETWORK_NAME.DEVNET, 'https://transport.devnet.miden.io'],
  [MIDEN_NETWORK_NAME.LOCALNET, 'http://127.0.0.1:57292']
]);

export const MIDEN_EXPLORER_ENDPOINTS = new Map<string, string>([
  [MIDEN_NETWORK_NAME.TESTNET, 'https://testnet.midenscan.com'],
  [MIDEN_NETWORK_NAME.DEVNET, 'https://devnet.midenscan.com']
]);

export function getExplorerTxUrl(txHash: string, network: string = DEFAULT_NETWORK): string | undefined {
  const base = MIDEN_EXPLORER_ENDPOINTS.get(network);
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

export const MIDEN_NETWORKS: MidenNetwork[] = [
  {
    rpcBaseURL: 'https://rpc.testnet.miden.io',
    id: MIDEN_NETWORK_NAME.TESTNET,
    name: 'Testnet',
    autoSync: true
  },
  {
    rpcBaseURL: 'https://rpc.devnet.miden.io',
    id: MIDEN_NETWORK_NAME.DEVNET,
    name: 'Devnet',
    autoSync: true
  },
  { rpcBaseURL: 'http://localhost:57291', id: MIDEN_NETWORK_NAME.LOCALNET, name: 'Localnet', autoSync: true }
];

/**
 * The Guardian providers a user can choose from during onboarding or when
 * switching their Guardian. Each provider maps the networks it supports to its
 * endpoint on that network (OpenZeppelin runs on both testnet and devnet; the
 * others currently expose a testnet endpoint only).
 */
export const GUARDIAN_OPTIONS: GuardianOption[] = [
  {
    id: 'open-zeppelin',
    name: 'Open-Zeppelin',
    operatedBy: 'Open-Zeppelin',
    location: 'US-EAST',
    endpoint: new Map<MIDEN_NETWORK_NAME, string>([
      [MIDEN_NETWORK_NAME.TESTNET, 'https://guardian.openzeppelin.com'],
      [MIDEN_NETWORK_NAME.DEVNET, 'https://guardian-stg.openzeppelin.com'],
      // Localnet dev/E2E: the OpenZeppelin guardian image run locally (HTTP :3000).
      [MIDEN_NETWORK_NAME.LOCALNET, 'http://localhost:3000']
    ])
  },
  {
    id: 'gateway',
    name: 'Gateway Operator',
    operatedBy: 'Gateway',
    location: 'EU-NORTH',
    endpoint: new Map<MIDEN_NETWORK_NAME, string>([
      [MIDEN_NETWORK_NAME.TESTNET, 'https://miden-guardian.dev.eu-north-3.gateway.fm']
    ])
  },
  {
    id: 'lambda-class',
    name: 'Lambda Class',
    operatedBy: 'Lambda Class',
    location: 'EU-WEST',
    endpoint: new Map<MIDEN_NETWORK_NAME, string>([
      [MIDEN_NETWORK_NAME.TESTNET, 'https://miden-guardian.lambdaclass.com']
    ])
  }
];

/**
 * A Guardian provider resolved to its endpoint on a specific network. Shared
 * shape for the onboarding picker (ChooseGuardian) and the import-flow presets.
 */
export interface ResolvedGuardianOption {
  id: string;
  name: string;
  operatedBy: string;
  location: string;
  endpoint: string;
}

/**
 * Resolve GUARDIAN_OPTIONS to the providers that run a Guardian on `network`,
 * each flattened to its endpoint on that network (in GUARDIAN_OPTIONS order).
 * Single source of truth so the create picker and import presets can't drift.
 */
export function getGuardianOptionsForNetwork(network: MIDEN_NETWORK_NAME = DEFAULT_NETWORK): ResolvedGuardianOption[] {
  return GUARDIAN_OPTIONS.filter(o => o.endpoint.has(network)).map(o => ({
    id: o.id,
    name: o.name,
    operatedBy: o.operatedBy,
    location: o.location,
    endpoint: o.endpoint.get(network)!
  }));
}

/**
 * All Guardian endpoints available per network, derived from GUARDIAN_OPTIONS:
 * each network maps to the list of provider endpoints that support it, in
 * GUARDIAN_OPTIONS order (so index 0 is the default provider — OpenZeppelin).
 */
export const MIDEN_GUARDIAN_ENDPOINTS: Map<string, string[]> = (() => {
  const byNetwork = new Map<string, string[]>();
  for (const option of GUARDIAN_OPTIONS) {
    for (const [network, endpoint] of option.endpoint) {
      const existing = byNetwork.get(network) ?? [];
      existing.push(endpoint);
      byNetwork.set(network, existing);
    }
  }
  return byNetwork;
})();

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
  const endpoints = MIDEN_GUARDIAN_ENDPOINTS.get(DEFAULT_NETWORK);
  if (!endpoints || endpoints.length === 0) {
    throw new Error(`Guardian is not available on network "${DEFAULT_NETWORK}": no Guardian endpoint is configured.`);
  }
  return endpoints[0]!;
}

/**
 * Returns the SDK NetworkId for the current DEFAULT_NETWORK.
 */
export function getNetworkId(): NetworkId {
  const network: string = DEFAULT_NETWORK;
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
 * Returns the SDK Endpoint for the current DEFAULT_NETWORK.
 *
 * NOTE: this constructs a wasm-bindgen-backed `Endpoint` instance and
 * therefore requires the SDK's WASM module to be loaded on this thread.
 * Page-side callers should `await ensureSdkWasmReady()` first.
 */
export function getRpcEndpoint(): Endpoint {
  const url = MIDEN_NETWORK_ENDPOINTS.get(DEFAULT_NETWORK)!;
  return new Endpoint(url);
}

/**
 * RPC endpoint URL string for `network` (defaults to the active network),
 * matching what `getRpcEndpoint()` and client creation use. The guardian/
 * multisig client (0.16+) no longer defaults the RPC endpoint internally, so
 * callers must pass it explicitly; falls back to the active network for
 * networks without a mapped endpoint (e.g. the mock client).
 */
export const getRpcEndpointUrl = (network: string = DEFAULT_NETWORK): string =>
  MIDEN_NETWORK_ENDPOINTS.get(network) ?? MIDEN_NETWORK_ENDPOINTS.get(DEFAULT_NETWORK)!;

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
