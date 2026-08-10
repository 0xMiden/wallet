import type { MidenNetwork } from 'lib/miden/types';
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

// REST API of the official faucet service — a different host from the
// MIDEN_FAUCET_ENDPOINTS website (locally the API binds :8000, frontend :8080).
export const MIDEN_FAUCET_API_ENDPOINTS = new Map<string, string>([
  [MIDEN_NETWORK_NAME.TESTNET, 'https://faucet-api.testnet.miden.io'],
  [MIDEN_NETWORK_NAME.DEVNET, 'https://faucet-api.devnet.miden.io'],
  [MIDEN_NETWORK_NAME.LOCALNET, 'http://localhost:8000']
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
 * Canonical Guardian provider brand names — the single source of truth for how
 * each operator is spelled in the UI (onboarding, Settings, Activity, recovery,
 * and success/error copy). Keeps spellings consistent (#464): "OpenZeppelin",
 * not "Open Zeppelin"/"Open-Zeppelin"; "LambdaClass", not "Lambda Class"/"Lambda".
 */
export const GUARDIAN_BRAND_NAME = {
  openZeppelin: 'OpenZeppelin',
  gateway: 'Gateway',
  lambdaClass: 'LambdaClass'
} as const;

/**
 * The Guardian providers a user can choose from during onboarding or when
 * switching their Guardian. Each provider maps the networks it supports to its
 * endpoint on that network (OpenZeppelin runs on both testnet and devnet; the
 * others currently expose a testnet endpoint only).
 */
export const GUARDIAN_OPTIONS: GuardianOption[] = [
  {
    id: 'open-zeppelin',
    name: GUARDIAN_BRAND_NAME.openZeppelin,
    operatedBy: GUARDIAN_BRAND_NAME.openZeppelin,
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
    name: `${GUARDIAN_BRAND_NAME.gateway} Operator`,
    operatedBy: GUARDIAN_BRAND_NAME.gateway,
    location: 'EU-NORTH',
    endpoint: new Map<MIDEN_NETWORK_NAME, string>([
      [MIDEN_NETWORK_NAME.TESTNET, 'https://miden-guardian.dev.eu-north-3.gateway.fm']
    ])
  },
  {
    id: 'lambda-class',
    name: GUARDIAN_BRAND_NAME.lambdaClass,
    operatedBy: GUARDIAN_BRAND_NAME.lambdaClass,
    location: 'EU-WEST',
    endpoint: new Map<MIDEN_NETWORK_NAME, string>([
      [MIDEN_NETWORK_NAME.TESTNET, 'https://miden-guardian.lambdaclass.com']
    ])
  },
  {
    id: 'kodax',
    name: 'Koda',
    operatedBy: 'Korea Digital Asset (Koda)',
    location: 'Asia (SK)',
    endpoint: new Map<MIDEN_NETWORK_NAME, string>([[MIDEN_NETWORK_NAME.TESTNET, 'https://guardian-testnet.kodax.com']])
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
