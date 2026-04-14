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
  },
  localhost: {
    name: 'localhost',
    rpcUrl: 'http://localhost:57291',
    provingUrl: 'http://localhost:50051',
    transportUrl: 'http://127.0.0.1:57292',
    networkFlag: 'localhost',
    pollIntervalMs: 2_000,
    txTimeoutMs: 60_000,
    mintAmount: 100_000_000_000,
    delegateProving: false,
  },
};

/**
 * Get the environment config for the current test run.
 * Selected via E2E_NETWORK env var, defaults to 'testnet'.
 */
export function getEnvironmentConfig(): EnvironmentConfig {
  const envName = process.env.E2E_NETWORK ?? 'testnet';
  const config = ENVIRONMENTS[envName];
  if (!config) {
    throw new Error(
      `Unknown E2E_NETWORK="${envName}". Valid options: ${Object.keys(ENVIRONMENTS).join(', ')}`
    );
  }
  return config;
}
