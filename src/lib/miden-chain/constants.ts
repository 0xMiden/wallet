import { Endpoint, MidenClient, NetworkId } from '@miden-sdk/miden-sdk/lazy';

import { MidenNetwork } from 'lib/miden/types';

export const NETWORK_STORAGE_ID = 'network_id';

export enum MIDEN_NETWORK_NAME {
  MAINNET = 'mainnet',
  TESTNET = 'testnet',
  DEVNET = 'devnet',
  LOCALNET = 'localnet'
}

/**
 * The default network used throughout the app.
 * Driven by the MIDEN_NETWORK env variable at build time (default: testnet).
 * Use `yarn build:devnet` to build for devnet.
 */
export const DEFAULT_NETWORK = (process.env.MIDEN_NETWORK as MIDEN_NETWORK_NAME) || MIDEN_NETWORK_NAME.TESTNET;

export enum MIDEN_TRANSPORT_LAYER_NAME {
  TESTNET = 'testnet',
  LOCALNET = 'localnet'
}

export const MIDEN_NETWORK_ENDPOINTS = new Map<string, string>([
  [MIDEN_NETWORK_NAME.MAINNET, 'https://api.miden.io'], // Placeholder
  [MIDEN_NETWORK_NAME.TESTNET, 'https://rpc.testnet.miden.io'],
  [MIDEN_NETWORK_NAME.DEVNET, 'http://localhost:57291'],
  [MIDEN_NETWORK_NAME.LOCALNET, 'http://localhost:57291']
]);

export const MIDEN_PROVING_ENDPOINTS = new Map<string, string>([
  [MIDEN_NETWORK_NAME.TESTNET, 'https://tx-prover.testnet.miden.io'],
  [MIDEN_NETWORK_NAME.DEVNET, 'https://tx-prover.devnet.miden.io'],
  [MIDEN_NETWORK_NAME.LOCALNET, 'http://localhost:50051']
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
 * Resolves once the SDK's WASM module is initialized on the current thread,
 * so subsequent `new Endpoint(...)` / `new RpcClient(...)` calls are safe.
 *
 * Delegates to `MidenClient.ready()` (0.14.4+), which is idempotent and
 * shared across callers.
 */
export function ensureSdkWasmReady(): Promise<void> {
  return MidenClient.ready();
}
