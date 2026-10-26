import testnet from './snapshot/testnet.json';

// A copy of 0xMiden/token-list's file at release time: the list a device shows before its first
// fetch, and whenever a fetch has never succeeded. Networks without a published list have none.
const SNAPSHOTS: Record<string, unknown> = { testnet };

export function bundledTokenList(network: string): unknown {
  return SNAPSHOTS[network] ?? null;
}
