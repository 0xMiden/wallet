import type { EnvironmentConfig } from '../harness/types';

/**
 * Environment configurations for E2E tests.
 * Endpoints sourced from src/lib/miden-chain/constants.ts.
 */
const ENVIRONMENTS: Record<string, EnvironmentConfig> = {
  testnet: {
    name: 'testnet',
    rpcUrl: 'https://rpc.testnet.miden.io',
    provingUrl: 'https://tx-prover.testnet.miden.io',
    transportUrl: 'https://transport.miden.io',
    networkFlag: 'testnet',
    pollIntervalMs: 5_000,
    txTimeoutMs: 180_000,
    mintAmount: 100_000_000_000, // 1000 tokens with 8 decimals
    delegateProving: true,
    // Real testnet guardian operators (from src/lib/miden-chain/constants.ts
    // GUARDIAN_OPTIONS). OpenZeppelin is the default/primary; Koda is a distinct
    // second operator for switch tests.
    guardianUrl: 'https://guardian.openzeppelin.com',
    guardianUrlB: 'https://guardian-testnet.kodax.com'
  },
  devnet: {
    name: 'devnet',
    rpcUrl: 'https://rpc.devnet.miden.io',
    provingUrl: 'https://tx-prover.devnet.miden.io',
    transportUrl: undefined, // auto-configured by miden-client init
    networkFlag: 'devnet',
    pollIntervalMs: 5_000,
    txTimeoutMs: 180_000,
    mintAmount: 100_000_000_000,
    delegateProving: true,
    // OpenZeppelin runs on devnet too; the other operators are testnet-only, so
    // there is no distinct second guardian for switch tests here.
    guardianUrl: 'https://guardian-stg.openzeppelin.com',
    // Devnet's 2026-08-27 re-genesis enabled fees; its genesis and tip headers both
    // report verification_base_fee = 10000. Testnet's header carries none.
    chargesFees: true
  },
  localhost: {
    name: 'localhost',
    rpcUrl: 'http://localhost:57291',
    provingUrl: 'http://localhost:50052', // :50051 is taken by the local guardian's gRPC
    transportUrl: 'http://127.0.0.1:57292',
    networkFlag: 'localhost',
    pollIntervalMs: 2_000,
    txTimeoutMs: 60_000,
    mintAmount: 100_000_000_000,
    delegateProving: false,
    // The two local guardian containers (guardian on :3000, guardian-b on :3001).
    guardianUrl: 'http://localhost:3000',
    guardianUrlB: 'http://localhost:3001'
  }
};

/**
 * Get the environment config for the current test run.
 * Selected via E2E_NETWORK env var, defaults to 'testnet'.
 */
export function getEnvironmentConfig(): EnvironmentConfig {
  const envName = process.env.E2E_NETWORK ?? 'testnet';
  const config = ENVIRONMENTS[envName];
  if (!config) {
    throw new Error(`Unknown E2E_NETWORK="${envName}". Valid options: ${Object.keys(ENVIRONMENTS).join(', ')}`);
  }
  return config;
}
